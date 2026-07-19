import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PayloadStore } from '../../core/payload-store.js';
import { resolveTyaHome } from '../../core/home.js';
import type {
  Adapter,
  DetectedHome,
  RawEvent,
  SessionRef,
  SessionSidechainRef,
} from '../../core/source.js';
import { parseSession } from './parse.js';
import { parseRow, str } from './transcript.js';

/**
 * Claude Code adapter. Reads `~/.claude` strictly read-only.
 *
 * On-disk layout (verified on a live install):
 * - main transcripts: `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`
 * - subagent sidechains: `<sessionId>/subagents/agent-<agentId>.jsonl`
 *   (newer layout, with a sibling `.meta.json`) or `agent-<agentId>.jsonl`
 *   directly in the project directory (older layout, attributed via the
 *   `sessionId` field of its first row).
 */

export interface ClaudeCodeAdapterOptions {
  /** Override the agent home (default `~/.claude`). Used by tests. */
  claudeHome?: string;
  /** Override the tya data root (for `joins.jsonl`). Default: resolveTyaHome(). */
  tyaHome?: string;
  /** When set, full tool inputs/results are stored and referenced via payloadRef. */
  payloadStore?: PayloadStore;
}

interface MainFile {
  projectDir: string;
  filePath: string;
  mtime: number;
  size: number;
}

const AGENT_FILE_RE = /^agent-(.+)\.jsonl$/;

function listMainFiles(projectsDir: string): MainFile[] {
  const out: MainFile[] = [];
  let projectDirs;
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirEntry of projectDirs) {
    if (!dirEntry.isDirectory()) continue;
    const projectDir = join(projectsDir, dirEntry.name);
    let files;
    try {
      files = readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl') || AGENT_FILE_RE.test(f.name)) continue;
      const filePath = join(projectDir, f.name);
      try {
        const st = statSync(filePath);
        out.push({ projectDir, filePath, mtime: st.mtimeMs, size: st.size });
      } catch {
        // unreadable file — skip
      }
    }
  }
  out.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return out;
}

/** First-line sessionId of a same-dir `agent-*.jsonl` (older layout attribution). */
function sidechainSessionId(filePath: string): string | undefined {
  let firstLine: string;
  try {
    const raw = readFileSync(filePath, 'utf8');
    firstLine = raw.slice(0, raw.indexOf('\n'));
  } catch {
    return undefined;
  }
  const row = parseRow(firstLine);
  return row === null ? undefined : str(row.sessionId);
}

function agentFileId(fileName: string): string | undefined {
  const m = AGENT_FILE_RE.exec(fileName);
  return m?.[1];
}

function withMeta(ref: { agentId: string; filePath: string }): SessionSidechainRef {
  const metaPath = ref.filePath.replace(/\.jsonl$/, '.meta.json');
  if (existsSync(metaPath)) return { ...ref, metaPath };
  return ref;
}

/** Sidechains belonging to one session: nested `<sessionId>/subagents/` first, then same-dir. */
function collectSidechains(projectDir: string, sessionId: string): SessionSidechainRef[] {
  const byAgent = new Map<string, SessionSidechainRef>();
  const subagentsDir = join(projectDir, sessionId, 'subagents');
  if (existsSync(subagentsDir)) {
    try {
      for (const f of readdirSync(subagentsDir, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const agentId = agentFileId(f.name);
        if (agentId === undefined) continue;
        byAgent.set(agentId, withMeta({ agentId, filePath: join(subagentsDir, f.name) }));
      }
    } catch {
      // unreadable subagents dir — fall through to same-dir scan
    }
  }
  try {
    for (const f of readdirSync(projectDir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const agentId = agentFileId(f.name);
      if (agentId === undefined || byAgent.has(agentId)) continue;
      const filePath = join(projectDir, f.name);
      if (sidechainSessionId(filePath) !== sessionId) continue;
      byAgent.set(agentId, withMeta({ agentId, filePath }));
    }
  } catch {
    // project dir unreadable
  }
  return [...byAgent.values()];
}

/** Version field of the most recently modified main file (first rows only). */
function detectVersion(files: readonly MainFile[]): string | undefined {
  let newest: MainFile | undefined;
  for (const f of files) {
    if (newest === undefined || f.mtime > newest.mtime) newest = f;
  }
  if (newest === undefined) return undefined;
  let head: string;
  try {
    head = readFileSync(newest.filePath, 'utf8').slice(0, 64 * 1024);
  } catch {
    return undefined;
  }
  for (const line of head.split('\n')) {
    const row = parseRow(line);
    if (row === null) continue;
    const version = str(row.version);
    if (version !== undefined) return version;
  }
  return undefined;
}

export class ClaudeCodeAdapter implements Adapter {
  readonly source = 'claude-code' as const;
  private readonly claudeHome: string;
  private readonly tyaHome: string;
  private readonly payloadStore: PayloadStore | undefined;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.claudeHome = options.claudeHome ?? join(homedir(), '.claude');
    this.tyaHome = options.tyaHome ?? resolveTyaHome();
    this.payloadStore = options.payloadStore;
  }

  async detect(): Promise<DetectedHome | null> {
    if (!existsSync(this.claudeHome)) return null;
    let readable = true;
    try {
      readdirSync(this.claudeHome);
    } catch {
      readable = false;
    }
    const projectsDir = join(this.claudeHome, 'projects');
    const files = existsSync(projectsDir) ? listMainFiles(projectsDir) : [];
    const version = detectVersion(files);
    return {
      source: this.source,
      homeDir: this.claudeHome,
      readable,
      sessionCount: files.length,
      ...(version !== undefined ? { version } : {}),
    };
  }

  async *discover(home: DetectedHome): AsyncIterable<SessionRef> {
    const projectsDir = join(home.homeDir, 'projects');
    for (const file of listMainFiles(projectsDir)) {
      const sessionId = file.filePath.slice(file.filePath.lastIndexOf('/') + 1, -'.jsonl'.length);
      const sidechains = collectSidechains(file.projectDir, sessionId);
      yield {
        source: this.source,
        sessionId,
        filePath: file.filePath,
        mtime: file.mtime,
        size: file.size,
        ...(sidechains.length > 0 ? { sidechains } : {}),
      };
    }
  }

  parse(session: SessionRef, fromOffset: number): AsyncIterable<RawEvent> {
    return parseSession({
      session,
      fromOffset,
      tyaHome: this.tyaHome,
      ...(this.payloadStore !== undefined ? { payloadStore: this.payloadStore } : {}),
    });
  }
}
