/**
 * kimi-code adapter: reads `~/.kimi-code` (or `$KIMI_CODE_HOME`) session
 * wire logs — v1 (packages/agent-core, current default engine) and v2
 * (agent-core-v2) — and normalizes them into RawEvents. See FORMAT.md.
 *
 * The agent home is treated as strictly read-only.
 */
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PayloadStore } from '../../core/payload-store.js';
import type { Adapter, DetectedHome, RawEvent, SessionRef } from '../../core/source.js';
import { parseKimiSession } from './parse.js';
import { listAgentWires } from './session-dir.js';
import { asNumber, asObject, asString, classifyProtocolVersion } from './wire.js';

export interface KimiCodeAdapterOptions {
  /** Env override (tests). Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** When present, full message payloads are stored and referenced from spans. */
  readonly payloadStore?: PayloadStore;
}

/** Resolve the kimi-code home: `$KIMI_CODE_HOME`, else `~/.kimi-code`. */
export function resolveKimiHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['KIMI_CODE_HOME'];
  if (override !== undefined && override.trim() !== '') return override;
  return join(homedir(), '.kimi-code');
}

export class KimiCodeAdapter implements Adapter {
  readonly source = 'kimi-code' as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly payloadStore?: PayloadStore;

  constructor(options: KimiCodeAdapterOptions = {}) {
    this.env = options.env ?? process.env;
    if (options.payloadStore !== undefined) this.payloadStore = options.payloadStore;
  }

  async detect(): Promise<DetectedHome | null> {
    const homeDir = resolveKimiHome(this.env);
    let homeStat;
    try {
      homeStat = await stat(homeDir);
    } catch {
      return null; // kimi-code not present on this machine
    }
    if (!homeStat.isDirectory()) return null;

    let readable = true;
    try {
      await access(homeDir, constants.R_OK);
      await access(join(homeDir, 'sessions'), constants.R_OK);
    } catch {
      readable = false;
    }

    const detected: DetectedHome = { source: this.source, homeDir, readable };
    const version = await this.sniffWireVersion(homeDir);
    if (version !== undefined) detected.version = version;
    return detected;
  }

  /**
   * Best-effort engine/version sniff: first wire.jsonl found, first line's
   * `protocol_version` → e.g. `wire 1.4 (v1)` (FORMAT.md §6).
   */
  private async sniffWireVersion(homeDir: string): Promise<string | undefined> {
    try {
      const sessionsDir = join(homeDir, 'sessions');
      for (const workspace of await readdir(sessionsDir)) {
        const workspaceDir = join(sessionsDir, workspace);
        for (const sessionId of await readdir(workspaceDir)) {
          const wires = await listAgentWires(join(workspaceDir, sessionId));
          const first = wires[0];
          if (first === undefined) continue;
          const buf = await readFile(first.filePath);
          const newline = buf.indexOf(0x0a);
          const line = buf.toString('utf8', 0, newline === -1 ? buf.length : newline);
          const record = asObject(JSON.parse(line));
          if (record?.['type'] !== 'metadata') continue;
          const version = asString(record['protocol_version']);
          if (version === undefined) continue;
          const protocol = classifyProtocolVersion(version);
          const engine = protocol?.engine ?? 'unknown';
          return `wire ${version} (${engine})`;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** Enumerate session directories; one SessionRef per session (all agent wires). */
  async *discover(home: DetectedHome): AsyncIterable<SessionRef> {
    const sessionsDir = join(home.homeDir, 'sessions');
    let workspaces: string[];
    try {
      workspaces = await readdir(sessionsDir);
    } catch {
      return;
    }
    for (const workspace of workspaces.sort()) {
      const workspaceDir = join(sessionsDir, workspace);
      let sessionIds: string[];
      try {
        sessionIds = await readdir(workspaceDir);
      } catch {
        continue;
      }
      for (const sessionId of sessionIds.sort()) {
        const sessionDir = join(workspaceDir, sessionId);
        const wires = await listAgentWires(sessionDir);
        const primary = wires.find((w) => w.agentId === 'main') ?? wires[0];
        if (primary === undefined) continue; // no wire files: nothing to parse
        try {
          const info = await stat(primary.filePath);
          yield {
            source: this.source,
            sessionId,
            filePath: primary.filePath,
            mtime: info.mtimeMs,
            size: info.size,
          };
        } catch {
          continue;
        }
      }
    }
  }

  /** Parse one session into RawEvents; resuming at `fromOffset` on the primary wire. */
  parse(session: SessionRef, fromOffset: number): AsyncIterable<RawEvent> {
    const options: { payloadStore?: PayloadStore } = {};
    if (this.payloadStore !== undefined) options.payloadStore = this.payloadStore;
    return parseKimiSession(session, fromOffset, options);
  }
}

// Re-exported for convenience (detect sniffing uses asNumber's siblings only).
export { UnknownWireProtocolError } from './wire.js';
export { KIMI_ATTR } from './parse.js';
void asNumber;
