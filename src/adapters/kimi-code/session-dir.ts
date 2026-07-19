/**
 * Session-directory layout for kimi-code (see FORMAT.md §1):
 *
 *   <home>/sessions/<workdirKey>/<sessionId>/
 *     state.json
 *     agents/<agentId>/wire.jsonl     (agentId 'main' for the main agent)
 *
 * Everything here is strictly read-only.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { asNumber, asObject, asString } from './wire.js';

/** state.json `agents[id]` entry (v1: homedir/type required; v2: all optional + labels). */
export interface AgentStateMeta {
  readonly type?: string;
  readonly parentAgentId?: string;
  readonly swarmItem?: string;
}

export interface SessionState {
  readonly workDir?: string;
  readonly title?: string;
  readonly createdAtMs?: number;
  /** v2 state.json carries a top-level `version: 2` (FORMAT.md §6). */
  readonly metaVersion?: number;
  readonly agents: Readonly<Record<string, AgentStateMeta>>;
}

/** Read `<sessionDir>/state.json`; `undefined` when missing or malformed. */
export async function readSessionState(sessionDir: string): Promise<SessionState | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(sessionDir, 'state.json'), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const root = asObject(parsed);
  if (root === undefined) return undefined;

  const agents: Record<string, AgentStateMeta> = {};
  const agentsRaw = asObject(root['agents']);
  if (agentsRaw !== undefined) {
    for (const [agentId, metaRaw] of Object.entries(agentsRaw)) {
      const meta = asObject(metaRaw);
      if (meta === undefined) continue;
      const entry: { type?: string; parentAgentId?: string; swarmItem?: string } = {};
      const type = asString(meta['type']);
      if (type !== undefined) entry.type = type;
      // v1: direct field; v2: direct field or labels.parentAgentId (FORMAT.md §5).
      const parentAgentId =
        asString(meta['parentAgentId']) ?? asString(asObject(meta['labels'])?.['parentAgentId']);
      if (parentAgentId !== undefined) entry.parentAgentId = parentAgentId;
      const swarmItem = asString(meta['swarmItem']);
      if (swarmItem !== undefined) entry.swarmItem = swarmItem;
      agents[agentId] = entry;
    }
  }

  const state: {
    workDir?: string;
    title?: string;
    createdAtMs?: number;
    metaVersion?: number;
    agents: Readonly<Record<string, AgentStateMeta>>;
  } = { agents };
  // v1 stores `workDir`, v2 stores `cwd`; accept both.
  const workDir = asString(root['workDir']) ?? asString(root['cwd']);
  if (workDir !== undefined) state.workDir = workDir;
  const title = asString(root['title']);
  if (title !== undefined) state.title = title;
  // v1 createdAt is an ISO string, v2 a ms number.
  const createdAt = root['createdAt'];
  const createdAtMs =
    typeof createdAt === 'string'
      ? Date.parse(createdAt)
      : asNumber(createdAt);
  if (createdAtMs !== undefined && Number.isFinite(createdAtMs)) state.createdAtMs = createdAtMs;
  const metaVersion = asNumber(root['version']);
  if (metaVersion !== undefined) state.metaVersion = metaVersion;
  return state;
}

export interface AgentWireFile {
  readonly agentId: string;
  readonly filePath: string;
}

/**
 * Enumerate `<sessionDir>/agents/<agentId>/wire.jsonl` files.
 * The main agent sorts first, then other agent ids alphabetically (deterministic).
 */
export async function listAgentWires(sessionDir: string): Promise<AgentWireFile[]> {
  const agentsDir = join(sessionDir, 'agents');
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const wires: AgentWireFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = join(agentsDir, entry.name, 'wire.jsonl');
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    wires.push({ agentId: entry.name, filePath });
  }
  wires.sort((a, b) => {
    if (a.agentId === 'main') return -1;
    if (b.agentId === 'main') return 1;
    return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
  });
  return wires;
}
