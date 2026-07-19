import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Adapter, DetectedHome, RawEvent, SessionRef } from '../../core/source.js';
import { ATTR, type JoinQuality, type SpanAttributeValue } from '../../core/types.js';
import type { PayloadStore } from '../../core/payload-store.js';
import {
  parseRolloutLine,
  extractThreadMeta,
  threadIdFromFilename,
  type CodexThreadMeta,
  type RolloutRecord,
} from './rollout.js';
import { parseThreadRecords, type ParsedThread } from './thread-parser.js';

/**
 * Bytes read from the top of each rollout file to grab its first line
 * (session_meta). The first line embeds base_instructions (the full system
 * prompt) and can reach tens of KB, so keep this generous.
 */
const HEAD_BYTES = 1024 * 1024;

/**
 * Codex adapter — reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * (strictly read-only) and normalizes threads into spans.
 *
 * Unlike single-file formats, Codex spreads one agent tree across MANY files
 * (one thread = one file; sub-agents are independent threads). Hence the two
 * phases:
 *
 * - Phase A (`thread-parser.ts`): each file independently → RawEvents
 *   (SESSION / AGENT_TURN / approx LLM_CALL / TOOL_CALL).
 * - Phase B (this file, `parse`): rebuild the cross-file graph. `discover`
 *   groups files into thread trees (one SessionRef per tree, keyed by the
 *   ROOT thread id); `parse` then re-parents each child thread's SESSION span
 *   under the parent thread's `spawn_agent` TOOL_CALL span and grades the
 *   attachment with `joinQuality`:
 *     structural — parent file has a `collab_agent_spawn_end` event whose
 *                  `new_thread_id` (or nickname) matches the child thread;
 *     semi       — time-nearest spawn_agent call whose arguments/output text
 *                  mentions the child thread id or nickname;
 *     heuristic  — time-nearest spawn_agent call, nothing else to go on;
 *     (orphan)   — no spawn candidate: SESSION stays a root span.
 *   Forked threads (`forked_from_id`) attach under the fork-parent's SESSION
 *   span (heuristic). Async spawns (parent demonstrably continued without any
 *   wait_agent/send_input targeting the child) get `detached: true` + a
 *   NOTIFY link; when in doubt, nothing is marked.
 *
 * Extension point: exact LLM_CALL spans (instead of approximations) require
 * the opt-in `CODEX_ROLLOUT_TRACE_ROOT` ingest bundle — hook it into
 * `thread-parser.ts` when a future milestone adds bundle support.
 */

const ROLLOUT_FILE_RE = /^rollout-.+\.jsonl$/;
/** session_meta lines can be huge (embedded base_instructions) — cap head reads. */
const HEAD_CHUNK = 64 * 1024;
const HEAD_MAX = 1024 * 1024;

export interface CodexAdapterOptions {
  /** Override the agent home (default: `$CODEX_HOME` or `~/.codex`). For tests. */
  homeDir?: string;
  /** When given, full message/tool contents are written to the payload store. */
  payloadStore?: PayloadStore;
}

/** Extra diagnostics for `tya doctor`; not part of the Adapter contract. */
export interface CodexHomeStats {
  rolloutFileCount: number;
  /** cli_version → number of rollout files carrying it. */
  cliVersions: Record<string, number>;
}

interface DiscoveredFile {
  filePath: string;
  mtime: number;
  size: number;
  meta: CodexThreadMeta;
}

interface Attachment {
  parentKey: string;
  joinQuality: JoinQuality;
  /** Set when attached to a spawn_agent call (used for detached detection). */
  spawn?: { toolKey: string; startMs: number };
}

export class CodexAdapter implements Adapter {
  readonly source = 'codex' as const;

  private readonly homeDir?: string;
  private readonly payloadStore?: PayloadStore;
  /** discover() result cache: root file path → tree files (root first). */
  private readonly treeCache = new Map<string, DiscoveredFile[]>();

  constructor(options: CodexAdapterOptions = {}) {
    if (options.homeDir !== undefined) this.homeDir = options.homeDir;
    if (options.payloadStore !== undefined) this.payloadStore = options.payloadStore;
  }

  resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
    if (this.homeDir !== undefined) return this.homeDir;
    const codexHome = env['CODEX_HOME'];
    if (codexHome !== undefined && codexHome.trim() !== '') return codexHome;
    return join(homedir(), '.codex');
  }

  async detect(): Promise<DetectedHome | null> {
    const homeDir = this.resolveHomeDir();
    const sessionsDir = join(homeDir, 'sessions');
    let readable = false;
    try {
      await fs.access(sessionsDir);
      readable = true;
    } catch {
      return null;
    }
    const stats = await this.collectStats({ source: 'codex', homeDir, readable });
    const home: DetectedHome = { source: 'codex', homeDir, readable };
    const version = mostCommon(stats.cliVersions);
    if (version !== undefined) home.version = version;
    return home;
  }

  /** Rollout file count + cli_version distribution (doctor/reporting). */
  async collectStats(home: DetectedHome): Promise<CodexHomeStats> {
    const files = await this.scanRolloutFiles(home.homeDir);
    const cliVersions: Record<string, number> = {};
    for (const file of files) {
      const v = file.meta.cliVersion ?? 'unknown';
      cliVersions[v] = (cliVersions[v] ?? 0) + 1;
    }
    return { rolloutFileCount: files.length, cliVersions };
  }

  async *discover(home: DetectedHome): AsyncIterable<SessionRef> {
    const files = await this.scanRolloutFiles(home.homeDir);
    const byId = new Map<string, DiscoveredFile>();
    for (const f of files) byId.set(f.meta.threadId, f);

    const children = new Map<string, DiscoveredFile[]>();
    const roots: DiscoveredFile[] = [];
    for (const f of files) {
      const parentId = treeParentId(f.meta, byId);
      const parent = parentId !== undefined ? byId.get(parentId) : undefined;
      if (parent === undefined) {
        roots.push(f);
      } else {
        const list = children.get(parent.meta.threadId);
        if (list === undefined) children.set(parent.meta.threadId, [f]);
        else list.push(f);
      }
    }

    // One SessionRef per thread tree, keyed by the root thread.
    roots.sort((a, b) => (a.meta.startedAtMs ?? a.mtime) - (b.meta.startedAtMs ?? b.mtime));
    for (const root of roots) {
      const tree: DiscoveredFile[] = [];
      const stack = [root];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined || seen.has(node.meta.threadId)) continue;
        seen.add(node.meta.threadId);
        tree.push(node);
        for (const child of children.get(node.meta.threadId) ?? []) stack.push(child);
      }
      this.treeCache.set(root.filePath, tree);
      let mtime = 0;
      let size = 0;
      for (const f of tree) {
        mtime = Math.max(mtime, f.mtime);
        size += f.size;
      }
      yield {
        source: 'codex',
        sessionId: root.meta.threadId,
        filePath: root.filePath,
        mtime,
        size,
      };
    }
  }

  async *parse(session: SessionRef, fromOffset: number): AsyncIterable<RawEvent> {
    const treeFiles = await this.resolveTreeFiles(session);
    const rootSessionId = session.sessionId;

    // ---- Phase A: parse every file of the tree independently. ----
    const parsed = new Map<string, ParsedThread>();
    let root: ParsedThread | undefined;
    for (const file of treeFiles) {
      const isRootFile = file.filePath === session.filePath;
      const lines = await readRolloutLines(file.filePath);
      const records: RolloutRecord[] = [];
      for (const line of lines) {
        const record = parseRolloutLine(line.lineNo, line.text);
        if (record !== undefined) records.push(record);
      }
      // Incremental resume: emit only records starting at/after fromOffset
      // (byte offsets are stable because line numbers count from byte 0).
      let emitFromLine = 0;
      if (isRootFile && fromOffset > 0) {
        const first = lines.find((l) => l.byteStart >= fromOffset && l.text.trim() !== '');
        emitFromLine = first?.lineNo ?? Number.MAX_SAFE_INTEGER;
      }
      const options: Parameters<typeof parseThreadRecords>[1] = {
        rootSessionId,
        fallbackThreadId: file.meta.threadId,
        emitFromLine,
      };
      if (this.payloadStore !== undefined) options.payloadStore = this.payloadStore;
      const thread = parseThreadRecords(records, options);
      parsed.set(thread.meta.threadId, thread);
      if (isRootFile) root = thread;
    }
    if (root === undefined) {
      // SessionRef did not match any parsed file (defensive; should not happen).
      return;
    }

    // ---- Phase B: cross-file graph assembly. ----
    const rootId = root.meta.threadId;
    const children = new Map<string, ParsedThread[]>();
    const topLevel: ParsedThread[] = [root];
    for (const thread of parsed.values()) {
      if (thread === root) continue;
      const parentId = thread.meta.parentThreadId ?? thread.meta.forkedFromId;
      const parent = parentId !== undefined ? parsed.get(parentId) : undefined;
      if (parent === undefined) {
        // Parent file missing from the tree: orphan, emitted at top level.
        topLevel.push(thread);
      } else {
        const list = children.get(parent.meta.threadId);
        if (list === undefined) children.set(parent.meta.threadId, [thread]);
        else list.push(thread);
      }
    }

    const materialize = (thread: ParsedThread): RawEvent[] => {
      const events = [...thread.events];
      const kids = [...(children.get(thread.meta.threadId) ?? [])].sort(
        (a, b) => (a.firstActivityMs ?? 0) - (b.firstActivityMs ?? 0),
      );
      for (const child of kids) {
        const childEvents = materialize(child);
        const attachment = attachChild(child, thread);
        if (attachment !== undefined) {
          patchSessionOpen(childEvents, attachment);
          // Async spawn: parent demonstrably continued (a later task_started)
          // without any wait/send/resume call naming the child thread.
          // Conservative: when in doubt, nothing is marked.
          if (attachment.spawn !== undefined) {
            const spawn = attachment.spawn;
            const waited = thread.waitArgTexts.some((t) => t.includes(child.meta.threadId));
            const continued = thread.turnStarts.some((t) => t > spawn.startMs);
            if (!waited && continued) {
              markDetached(childEvents, spawn.toolKey, child.sessionKey);
            }
          }
          const at = events.findIndex((e) => e.type === 'span.open' && e.key === attachment.parentKey);
          if (at >= 0) {
            events.splice(at + 1, 0, ...childEvents);
            continue;
          }
        }
        // Orphan (or dangling parent key): append after the parent's events as
        // a root-level span tree — never lose data.
        events.push(...childEvents);
      }
      return events;
    };

    for (const thread of topLevel) {
      for (const event of materialize(thread)) yield event;
    }
  }

  /** Tree files for a SessionRef: discover() cache, else rescan from disk. */
  private async resolveTreeFiles(session: SessionRef): Promise<DiscoveredFile[]> {
    const cached = this.treeCache.get(session.filePath);
    if (cached !== undefined) return cached;

    const sessionsRoot = findSessionsRoot(session.filePath);
    if (sessionsRoot === undefined) {
      const single = await statAsDiscovered(session.filePath, session.sessionId);
      return [single];
    }
    const all = await this.scanRolloutFiles(join(sessionsRoot, '..'));
    const byId = new Map(all.map((f) => [f.meta.threadId, f] as const));
    const root = byId.get(session.sessionId);
    if (root === undefined) {
      const single = await statAsDiscovered(session.filePath, session.sessionId);
      return [single];
    }
    // Collect the subtree via parent pointers.
    const tree: DiscoveredFile[] = [root];
    let frontier = [root.meta.threadId];
    const seen = new Set(frontier);
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const f of all) {
        if (seen.has(f.meta.threadId)) continue;
        const parentId = treeParentId(f.meta, byId);
        if (parentId !== undefined && seen.has(parentId)) {
          seen.add(f.meta.threadId);
          tree.push(f);
          next.push(f.meta.threadId);
        }
      }
      frontier = next;
    }
    return tree;
  }

  /** Enumerate rollout files under `<home>/sessions` with their session_meta. */
  private async scanRolloutFiles(homeDir: string): Promise<DiscoveredFile[]> {
    const sessionsDir = join(homeDir, 'sessions');
    const paths: string[] = [];
    await walkJsonl(sessionsDir, paths);
    const out: DiscoveredFile[] = [];
    for (const filePath of paths) {
      try {
        const stat = await fs.stat(filePath);
        const head = await readHead(filePath, HEAD_BYTES);
        const firstLine = head.split('\n', 1)[0] ?? '';
        const record = parseRolloutLine(0, firstLine);
        const meta =
          record?.type === 'session_meta'
            ? extractThreadMeta(record.payload)
            : undefined;
        const fallback = threadIdFromFilename(basename(filePath));
        out.push({
          filePath,
          mtime: stat.mtimeMs,
          size: stat.size,
          meta: meta ?? { threadId: fallback ?? filePath },
        });
      } catch {
        // Unreadable file: skip, never fail the scan.
      }
    }
    out.sort((a, b) => a.filePath.localeCompare(b.filePath));
    return out;
  }
}

/** Parent used for tree building: spawn parent, else fork origin. */
function treeParentId(
  meta: CodexThreadMeta,
  byId: Map<string, DiscoveredFile>,
): string | undefined {
  if (meta.parentThreadId !== undefined && byId.has(meta.parentThreadId)) {
    return meta.parentThreadId;
  }
  if (meta.forkedFromId !== undefined && byId.has(meta.forkedFromId)) {
    return meta.forkedFromId;
  }
  return undefined;
}

/**
 * Decide where a child thread's SESSION span hangs (phase B join logic).
 * Returns undefined for orphans.
 */
function attachChild(child: ParsedThread, parent: ParsedThread): Attachment | undefined {
  const childStart = child.firstActivityMs ?? child.meta.startedAtMs ?? 0;
  const nickname = child.meta.agentNickname;

  // Forks are not spawned: attach under the origin thread's SESSION span.
  if (child.meta.parentThreadId === undefined && child.meta.forkedFromId !== undefined) {
    return { parentKey: parent.sessionKey, joinQuality: 'heuristic' };
  }

  // 1) structural: a collab_agent_spawn_end event names the child thread.
  for (const end of parent.collabSpawnEnds) {
    const matches =
      end.newThreadId === child.meta.threadId ||
      (nickname !== undefined && end.newAgentNickname === nickname);
    if (!matches) continue;
    const spawn = parent.spawnCalls.find((c) => c.callId === end.callId);
    if (spawn !== undefined) {
      return { parentKey: spawn.toolKey, joinQuality: 'structural', spawn };
    }
  }

  const nearest = (candidates: typeof parent.spawnCalls): (typeof parent.spawnCalls)[number] | undefined => {
    let best: (typeof parent.spawnCalls)[number] | undefined;
    for (const c of candidates) {
      if (best === undefined || Math.abs(c.startMs - childStart) < Math.abs(best.startMs - childStart)) {
        best = c;
      }
    }
    return best;
  };

  // 2) semi: spawn args/output mention the child id or nickname.
  const matching = parent.spawnCalls.filter((c) => {
    if (c.argsText.includes(child.meta.threadId)) return true;
    if (c.outputText !== undefined && c.outputText.includes(child.meta.threadId)) return true;
    if (nickname !== undefined && c.argsText.includes(nickname)) return true;
    if (nickname !== undefined && c.outputText !== undefined && c.outputText.includes(nickname)) {
      return true;
    }
    return false;
  });
  const semiMatch = nearest(matching);
  if (semiMatch !== undefined) {
    return { parentKey: semiMatch.toolKey, joinQuality: 'semi', spawn: semiMatch };
  }

  // 3) heuristic: only the time window.
  const anySpawn = nearest(parent.spawnCalls);
  if (anySpawn !== undefined) {
    return { parentKey: anySpawn.toolKey, joinQuality: 'heuristic', spawn: anySpawn };
  }

  return undefined;
}

/** Patch the child's SESSION span.open with parent wiring + join attributes. */
function patchSessionOpen(childEvents: RawEvent[], attachment: Attachment): void {
  for (const event of childEvents) {
    if (event.type !== 'span.open' || event.kind !== 'SESSION') continue;
    event.parentKey = attachment.parentKey;
    const attributes: Record<string, SpanAttributeValue> = {
      ...event.attributes,
      [ATTR.JOIN_QUALITY]: attachment.joinQuality,
    };
    event.attributes = attributes;
    break;
  }
}

/**
 * Detached (async spawn) markers, applied to already-materialized child event
 * lists by `markDetached` — see below. Kept separate from the join decision so
 * the splice position stays simple.
 */
export function markDetached(
  childEvents: RawEvent[],
  notifyFromKey: string,
  sessionKey: string,
): void {
  for (const event of childEvents) {
    if (event.type === 'span.open' && event.kind === 'SESSION') {
      event.attributes = { ...event.attributes, [ATTR.DETACHED]: true };
    }
  }
  childEvents.push({ type: 'link', fromKey: notifyFromKey, toKey: sessionKey, kind: 'NOTIFY' });
}

async function statAsDiscovered(filePath: string, threadId: string): Promise<DiscoveredFile> {
  const stat = await fs.stat(filePath);
  return { filePath, mtime: stat.mtimeMs, size: stat.size, meta: { threadId } };
}

/** Walk up from a rollout file to the `sessions` directory; undefined if not under one. */
function findSessionsRoot(filePath: string): string | undefined {
  let dir = join(filePath, '..');
  for (let i = 0; i < 8; i += 1) {
    if (basename(dir) === 'sessions') return dir;
    const parent = join(dir, '..');
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

async function walkJsonl(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonl(full, out);
    } else if (entry.isFile() && ROLLOUT_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
}

async function readHead(filePath: string, bytes: number): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

interface RawLine {
  lineNo: number;
  text: string;
  byteStart: number;
}

/** Read a whole rollout file into lines with stable line numbers + byte offsets. */
async function readRolloutLines(filePath: string): Promise<RawLine[]> {
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split('\n');
  const out: RawLine[] = [];
  let byteStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? '';
    out.push({ lineNo: i, text, byteStart });
    byteStart += Buffer.byteLength(text, 'utf8') + 1;
  }
  return out;
}

function mostCommon(counts: Record<string, number>): string | undefined {
  let best: string | undefined;
  let bestN = 0;
  for (const [key, n] of Object.entries(counts)) {
    if (key === 'unknown') continue;
    if (n > bestN) {
      best = key;
      bestN = n;
    }
  }
  return best;
}
