import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PayloadStore } from '../../core/payload-store.js';
import type { RawEvent, SessionRef, SessionSidechainRef } from '../../core/source.js';
import { ATTR, toSummary, type JoinQuality, type SpanAttributeValue, type TokenUsage } from '../../core/types.js';
import {
  IGNORED_TYPES,
  isToolResultRow,
  parseRow,
  parseTs,
  str,
  toolResultText,
  viewMessage,
  type CcBlock,
  type CcRow,
  type CcUsage,
} from './transcript.js';

/**
 * Parser: turns one Claude Code session (main transcript + subagent
 * sidechains) into a RawEvent stream for the ingest pipeline.
 *
 * Two phases:
 * - A) read and index every row (main file honoring `fromOffset`, sidechains
 *   always in full — records are at-least-once and span ids are idempotent,
 *   so re-emitted sidechain rows are harmless). Join decisions (3-tier, see
 *   below) and detached-task detection are computed here, order-independently.
 * - B) rows from all files are merged by timestamp into a single stream and
 *   replayed through one state machine (per-agent turns, LLM calls, tool
 *   calls), so a Task TOOL_CALL span is still open when its subagent's rows
 *   arrive and can be wired as the parent (`parentKey` requires an open span).
 *
 * Join tiers for a sidechain (parent = the main-file Task tool_use span):
 * 1. `agent-<id>.meta.json` with an explicit parent field → structural.
 * 2. `<tyaHome>/joins.jsonl` (hooks sidecar) matched by sessionId+agentId → structural.
 * 3. heuristic: sidechain's first prompt equals a Task `input.prompt` and both
 *    are within ±10 min → heuristic.
 * No match → the sidechain's spans are emitted as orphans (no parentSpanId,
 * no joinQuality attribute).
 */

const MAIN_AGENT = 'main';
const HEURISTIC_WINDOW_MS = 10 * 60 * 1000;
/** Fields in `agent-*.meta.json` understood as an explicit parent link. */
const META_PARENT_FIELDS = ['parentToolUseId', 'toolUseId', 'taskToolUseId', 'spawnedByToolUseId'] as const;
/** A bare task id as produced by async Task tool_results (single token). */
const TASK_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export interface ParseOptions {
  session: SessionRef;
  fromOffset: number;
  /** tya data root; `<tyaHome>/joins.jsonl` is consulted for structural joins. */
  tyaHome: string;
  payloadStore?: PayloadStore;
}

interface IndexedRow {
  row: CcRow;
  rowKey: string;
  tsMs: number;
  agentKey: string;
  seq: number;
}

interface TaskToolUse {
  toolUseId: string;
  tsMs: number;
  prompt?: string;
}

interface JoinDecision {
  agentId: string;
  toolUseId?: string;
  quality?: JoinQuality;
  detached: boolean;
  taskToken?: string;
}

interface OpenTool {
  key: string;
  toolName: string;
  input: unknown;
}

interface AgentState {
  turnKey: string | undefined;
  turnStartMs: number;
  turnRowCount: number;
  turnCounter: number;
  lastTsMs: number | undefined;
  lastUserText: string | undefined;
  rootDecorated: boolean;
  openTools: Map<string, OpenTool>;
}

/** Read one transcript file into indexed rows, skipping malformed/ignored lines. */
function readRows(filePath: string, agentKey: string, fromOffset: number, seqStart: number): { rows: IndexedRow[]; nextSeq: number } {
  const raw = readFileSync(filePath, 'utf8');
  let body = raw;
  let lineBase = 0;
  if (fromOffset > 0) {
    let start = fromOffset;
    if (start > raw.length) start = raw.length;
    // Resume at the first complete record at/after the offset: unless the
    // offset sits exactly after a newline, the record it lands in is partial.
    if (start > 0 && raw[start - 1] !== '\n') {
      const nl = raw.indexOf('\n', start);
      start = nl === -1 ? raw.length : nl + 1;
    }
    lineBase = (raw.slice(0, start).match(/\n/g) ?? []).length;
    body = raw.slice(start);
  }
  const rows: IndexedRow[] = [];
  const fileTag = basename(filePath);
  let seq = seqStart;
  let lastValidTs: number | undefined;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const row = parseRow(line);
    if (row === null) continue;
    const type = str(row.type);
    if (type === undefined || IGNORED_TYPES.has(type)) continue;
    const ts = parseTs(row.timestamp) ?? lastValidTs;
    if (ts === undefined) continue; // no usable timestamp yet — cannot place the row
    lastValidTs = ts;
    const lineNo = lineBase + i + 1;
    const uuid = str(row.uuid);
    // Subagent rows embedded in the main file (older CC format) are attributed
    // to their agent; everything else belongs to the file's owner.
    let effectiveAgent = agentKey;
    if (agentKey === MAIN_AGENT && row.isSidechain === true) {
      const embedded = str(row.agentId);
      if (embedded !== undefined) effectiveAgent = embedded;
    }
    rows.push({
      row,
      rowKey: uuid ?? `${fileTag}:${lineNo}`,
      tsMs: ts,
      agentKey: effectiveAgent,
      seq: seq++,
    });
  }
  return { rows, nextSeq: seq };
}

function readMetaJson(metaPath: string | undefined): Record<string, unknown> | undefined {
  if (metaPath === undefined || !existsSync(metaPath)) return undefined;
  try {
    const obj: unknown = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
  } catch {
    // malformed meta file — treated as absent
  }
  return undefined;
}

interface JoinSidecarEntry {
  sessionId?: string;
  agentId?: string;
  toolUseId?: string;
}

function readJoinSidecar(tyaHome: string): JoinSidecarEntry[] {
  const filePath = join(tyaHome, 'joins.jsonl');
  if (!existsSync(filePath)) return [];
  const out: JoinSidecarEntry[] = [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  for (const line of raw.split('\n')) {
    const row = parseRow(line);
    if (row === null) continue;
    const rec = row as Record<string, unknown>;
    const entry: JoinSidecarEntry = {};
    const sessionId = str(rec['sessionId']);
    const agentId = str(rec['agentId']);
    const toolUseId = str(rec['toolUseId']) ?? str(rec['parentToolUseId']);
    if (sessionId !== undefined) entry.sessionId = sessionId;
    if (agentId !== undefined) entry.agentId = agentId;
    if (toolUseId !== undefined) entry.toolUseId = toolUseId;
    out.push(entry);
  }
  return out;
}

function firstPromptText(rows: readonly IndexedRow[]): { text: string; tsMs: number } | undefined {
  for (const r of rows) {
    if (str(r.row.type) !== 'user') continue;
    const msg = viewMessage(r.row.message);
    if (isToolResultRow(r.row, msg)) continue;
    const text = msg?.text.trim() ?? '';
    if (text !== '') return { text, tsMs: r.tsMs };
  }
  return undefined;
}

/** Decide how a sidechain attaches to the main span tree (3 tiers, see header). */
function resolveJoin(
  sidechain: SessionSidechainRef,
  sidechainRows: readonly IndexedRow[],
  taskToolUses: readonly TaskToolUse[],
  mainToolUseIds: ReadonlySet<string>,
  detachedTokens: ReadonlyMap<string, string>,
  sidecar: readonly JoinSidecarEntry[],
  sessionId: string,
): JoinDecision {
  const base: JoinDecision = { agentId: sidechain.agentId, detached: false };
  // Tier 1: explicit parent field in agent-<id>.meta.json.
  const meta = readMetaJson(sidechain.metaPath);
  if (meta !== undefined) {
    for (const field of META_PARENT_FIELDS) {
      const candidate = str(meta[field]);
      if (candidate !== undefined && mainToolUseIds.has(candidate)) {
        return withDetached({ ...base, toolUseId: candidate, quality: 'structural' }, detachedTokens);
      }
    }
  }
  // Tier 2: hooks sidecar joins.jsonl matched by sessionId + agentId.
  for (const entry of sidecar) {
    if (entry.sessionId === sessionId && entry.agentId === sidechain.agentId && entry.toolUseId !== undefined && mainToolUseIds.has(entry.toolUseId)) {
      return withDetached({ ...base, toolUseId: entry.toolUseId, quality: 'structural' }, detachedTokens);
    }
  }
  // Tier 3: prompt-text equality with a Task tool_use within ±10 min.
  const first = firstPromptText(sidechainRows);
  if (first !== undefined) {
    let best: { toolUseId: string; delta: number } | undefined;
    for (const task of taskToolUses) {
      if (task.prompt === undefined || task.prompt.trim() !== first.text) continue;
      const delta = Math.abs(task.tsMs - first.tsMs);
      if (delta > HEURISTIC_WINDOW_MS) continue;
      if (best === undefined || delta < best.delta) best = { toolUseId: task.toolUseId, delta };
    }
    if (best !== undefined) {
      return withDetached({ ...base, toolUseId: best.toolUseId, quality: 'heuristic' }, detachedTokens);
    }
  }
  return base;
}

function withDetached(decision: JoinDecision, detachedTokens: ReadonlyMap<string, string>): JoinDecision {
  if (decision.toolUseId === undefined) return decision;
  const token = detachedTokens.get(decision.toolUseId);
  if (token === undefined) return decision;
  return { ...decision, detached: true, taskToken: token };
}

function toTokenUsage(u: CcUsage): TokenUsage | undefined {
  if (u.inputTokens === undefined && u.outputTokens === undefined) return undefined;
  const out: TokenUsage = { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 };
  if (u.cacheReadTokens !== undefined) out.cacheReadTokens = u.cacheReadTokens;
  if (u.cacheWriteTokens !== undefined) out.cacheWriteTokens = u.cacheWriteTokens;
  return out;
}

function safeJson(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export async function* parseSession(options: ParseOptions): AsyncIterable<RawEvent> {
  const { session, fromOffset, tyaHome, payloadStore } = options;
  const sessionId = session.sessionId;

  // ---- Phase A: read + index -------------------------------------------------
  const main = readRows(session.filePath, MAIN_AGENT, fromOffset, 0);
  const sidechains = session.sidechains ?? [];
  const sidechainRows = new Map<string, IndexedRow[]>();
  let seq = main.nextSeq;
  for (const sc of sidechains) {
    if (!existsSync(sc.filePath)) {
      sidechainRows.set(sc.agentId, []);
      continue;
    }
    const read = readRows(sc.filePath, sc.agentId, 0, seq);
    seq = read.nextSeq;
    sidechainRows.set(sc.agentId, read.rows);
  }

  const all: IndexedRow[] = [...main.rows];
  for (const rows of sidechainRows.values()) all.push(...rows);
  if (all.length === 0) return;
  all.sort((a, b) => (a.tsMs !== b.tsMs ? a.tsMs - b.tsMs : a.seq - b.seq));

  const sessionStartMs = all[0]?.tsMs ?? 0;
  const cwd = all.map((r) => str(r.row.cwd)).find((c): c is string => c !== undefined);

  // Main-file tool_use index (any tool) + Task tool_use index (for joins).
  const mainToolUseIds = new Set<string>();
  const taskToolUses: TaskToolUse[] = [];
  const toolResultTextByToolUseId = new Map<string, { text: string; tsMs: number }>();
  const mainUserTexts: Array<{ text: string; tsMs: number }> = [];
  for (const r of main.rows) {
    const type = str(r.row.type);
    const msg = viewMessage(r.row.message);
    if (type === 'assistant' && msg?.blocks != null) {
      for (const b of msg.blocks) {
        if (b.type !== 'tool_use' || b.id === undefined) continue;
        mainToolUseIds.add(b.id);
        if (b.name === 'Task') {
          const input = b.input !== null && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : undefined;
          const prompt = input !== undefined ? str(input['prompt']) : undefined;
          const task: TaskToolUse = { toolUseId: b.id, tsMs: r.tsMs };
          if (prompt !== undefined) task.prompt = prompt;
          taskToolUses.push(task);
        }
      }
    } else if (type === 'user') {
      if (isToolResultRow(r.row, msg) && msg?.blocks != null) {
        for (const b of msg.blocks) {
          if (b.type === 'tool_result' && b.toolUseId !== undefined) {
            toolResultTextByToolUseId.set(b.toolUseId, { text: toolResultText(b).trim(), tsMs: r.tsMs });
          }
        }
      } else if (msg !== undefined && msg.text !== '') {
        mainUserTexts.push({ text: msg.text, tsMs: r.tsMs });
      }
    }
  }

  // Detached (async) Task detection: tool_result is a bare task id AND a later
  // user row carries a <task-notification> mentioning that id. Both signals
  // required — when unsure, nothing is marked.
  const detachedTokens = new Map<string, string>(); // toolUseId -> task token
  for (const task of taskToolUses) {
    const result = toolResultTextByToolUseId.get(task.toolUseId);
    if (result === undefined || !TASK_ID_RE.test(result.text)) continue;
    const notified = mainUserTexts.some(
      (u) => u.tsMs >= result.tsMs && u.text.includes('<task-notification>') && u.text.includes(result.text),
    );
    if (notified) detachedTokens.set(task.toolUseId, result.text);
  }

  // Join decisions per sidechain.
  const sidecar = readJoinSidecar(tyaHome);
  const joins = new Map<string, JoinDecision>();
  for (const sc of sidechains) {
    joins.set(
      sc.agentId,
      resolveJoin(sc, sidechainRows.get(sc.agentId) ?? [], taskToolUses, mainToolUseIds, detachedTokens, sidecar, sessionId),
    );
  }
  // Sidechains embedded in the main file (older format) get the heuristic tier.
  for (const r of all) {
    if (r.agentKey !== MAIN_AGENT && !joins.has(r.agentKey)) {
      const embedded: SessionSidechainRef = { agentId: r.agentKey, filePath: session.filePath };
      joins.set(
        r.agentKey,
        resolveJoin(
          embedded,
          all.filter((x) => x.agentKey === r.agentKey),
          taskToolUses,
          mainToolUseIds,
          detachedTokens,
          sidecar,
          sessionId,
        ),
      );
    }
  }
  // Reverse index: Task toolUseId -> joined agent (for NOTIFY links).
  const agentByToolUseId = new Map<string, string>();
  for (const j of joins.values()) {
    if (j.toolUseId !== undefined) agentByToolUseId.set(j.toolUseId, j.agentId);
  }

  // ---- Phase B: replay merged stream ------------------------------------------
  const events: RawEvent[] = [];
  const agents = new Map<string, AgentState>();
  const openNow = new Set<string>();
  const openedKeys = new Set<string>();
  const pendingLinks: Array<{ fromKey: string; toKey: string }> = [];
  const emittedLinks = new Set<string>();
  const metaCache = new Map<string, Record<string, unknown> | undefined>();
  let lastTsMs = sessionStartMs;

  const stateFor = (agentKey: string): AgentState => {
    let s = agents.get(agentKey);
    if (s === undefined) {
      s = {
        turnKey: undefined,
        turnStartMs: 0,
        turnRowCount: 0,
        turnCounter: 0,
        lastTsMs: undefined,
        lastUserText: undefined,
        rootDecorated: false,
        openTools: new Map(),
      };
      agents.set(agentKey, s);
    }
    return s;
  };

  const agentAttrs = (agentKey: string): Record<string, SpanAttributeValue> => {
    // session.id + source are stamped on every span: the store derives its
    // per-session aggregates from these attributes (see store.ts spanToRow).
    const attrs: Record<string, SpanAttributeValue> = {
      [ATTR.SESSION_ID]: sessionId,
      [ATTR.SOURCE]: 'claude-code',
      [ATTR.AGENT_ID]: agentKey,
    };
    if (agentKey !== MAIN_AGENT) {
      const metaPath = sidechains.find((sc) => sc.agentId === agentKey)?.metaPath;
      let meta = metaCache.get(agentKey);
      if (meta === undefined && !metaCache.has(agentKey)) {
        meta = readMetaJson(metaPath);
        metaCache.set(agentKey, meta);
      }
      const name = str(meta?.['agentType']) ?? str(meta?.['description']) ?? agentKey;
      attrs['agent.name'] = name;
    }
    return attrs;
  };

  const openSpan = (ev: RawEvent & { type: 'span.open' }): void => {
    openNow.add(ev.key);
    openedKeys.add(ev.key);
    events.push(ev);
  };

  /** Parent key for a span of `agentKey` opened right now. */
  const currentParentKey = (agentKey: string): string | undefined => {
    const s = stateFor(agentKey);
    if (s.turnKey !== undefined) return s.turnKey;
    if (agentKey === MAIN_AGENT) return 'session';
    const join = joins.get(agentKey);
    if (join?.toolUseId !== undefined && !join.detached) {
      const parentKey = `tool:${MAIN_AGENT}:${join.toolUseId}`;
      if (openNow.has(parentKey)) return parentKey;
    }
    return undefined; // orphan branch
  };

  /** Join decorations (joinQuality / detached / agent.parent.id) for a sidechain root span. */
  const rootJoinAttrs = (agentKey: string): Record<string, SpanAttributeValue> => {
    const s = stateFor(agentKey);
    if (agentKey === MAIN_AGENT || s.rootDecorated) return {};
    s.rootDecorated = true;
    const join = joins.get(agentKey);
    if (join?.toolUseId === undefined) return {};
    const attrs: Record<string, SpanAttributeValue> = { [ATTR.AGENT_PARENT_ID]: MAIN_AGENT };
    // joinQuality is recorded only when the parent wiring actually happened
    // (or the join is a confirmed detached async task).
    const parentKey = `tool:${MAIN_AGENT}:${join.toolUseId}`;
    if (join.detached || openNow.has(parentKey)) {
      if (join.quality !== undefined) attrs[ATTR.JOIN_QUALITY] = join.quality;
    }
    if (join.detached) attrs[ATTR.DETACHED] = true;
    return attrs;
  };

  /** parentKey for a sidechain root span; undefined unless the Task span is open now. */
  const rootParentKey = (agentKey: string): string | undefined => {
    const join = joins.get(agentKey);
    if (agentKey === MAIN_AGENT || join?.toolUseId === undefined || join.detached) return undefined;
    const parentKey = `tool:${MAIN_AGENT}:${join.toolUseId}`;
    return openNow.has(parentKey) ? parentKey : undefined;
  };

  const openTurn = (agentKey: string, row: IndexedRow): void => {
    const s = stateFor(agentKey);
    const key = `turn:${agentKey}:${s.turnCounter}`;
    s.turnCounter += 1;
    s.turnKey = key;
    s.turnStartMs = row.tsMs;
    s.turnRowCount = 1;
    const attributes: Record<string, SpanAttributeValue> = {
      ...agentAttrs(agentKey),
      ...rootJoinAttrs(agentKey),
    };
    const parentKey = agentKey === MAIN_AGENT ? 'session' : rootParentKey(agentKey);
    openSpan({
      type: 'span.open',
      key,
      ...(parentKey !== undefined ? { parentKey } : {}),
      sourceRowKey: row.rowKey,
      kind: 'AGENT_TURN',
      name: 'turn',
      startTimeMs: row.tsMs,
      attributes,
      ...(agentKey !== MAIN_AGENT ? { agentName: String(agentAttrs(agentKey)['agent.name'] ?? agentKey) } : {}),
    });
  };

  const closeTurn = (agentKey: string, endTimeMs: number, extraAttrs?: Record<string, SpanAttributeValue>): void => {
    const s = stateFor(agentKey);
    if (s.turnKey === undefined) return;
    const attributes: Record<string, SpanAttributeValue> = { 'turn.rowCount': s.turnRowCount, ...extraAttrs };
    events.push({ type: 'span.close', key: s.turnKey, endTimeMs, attributes });
    openNow.delete(s.turnKey);
    s.turnKey = undefined;
  };

  // Session meta + root span.
  const metaEvent: RawEvent = {
    type: 'session.meta',
    startedAtMs: sessionStartMs,
    ...(cwd !== undefined ? { cwd } : {}),
  };
  events.push(metaEvent);
  const sessionAttrs: Record<string, SpanAttributeValue> = {
    [ATTR.SESSION_ID]: sessionId,
    [ATTR.SOURCE]: 'claude-code',
  };
  if (cwd !== undefined) sessionAttrs['cwd'] = cwd;
  openSpan({
    type: 'span.open',
    key: 'session',
    sourceRowKey: `session:${sessionId}`,
    kind: 'SESSION',
    name: sessionId,
    startTimeMs: sessionStartMs,
    attributes: sessionAttrs,
  });

  for (const item of all) {
    const { row, agentKey } = item;
    const type = str(row.type);
    const s = stateFor(agentKey);
    lastTsMs = Math.max(lastTsMs, item.tsMs);
    const countRow = (): void => {
      if (s.turnKey !== undefined) s.turnRowCount += 1;
    };

    if (type === 'user') {
      const msg = viewMessage(row.message);
      if (row.toolUseResult !== undefined) {
        // Tool result row: close matching TOOL_CALL span(s).
        countRow();
        const blocks = msg?.blocks?.filter((b) => b.type === 'tool_result') ?? [];
        for (const b of blocks) {
          if (b.toolUseId === undefined) continue;
          const open = s.openTools.get(b.toolUseId);
          if (open === undefined) continue;
          s.openTools.delete(b.toolUseId);
          const text = toolResultText(b);
          if (text !== '') s.lastUserText = text;
          let payloadRef: string | undefined;
          if (payloadStore !== undefined) {
            payloadRef = payloadStore.put({ tool: open.toolName, input: open.input, result: b.content ?? row.toolUseResult });
          }
          const closeEv: RawEvent = {
            type: 'span.close',
            key: open.key,
            endTimeMs: item.tsMs,
            ...(b.isError === true ? { status: { code: 'error' as const } } : {}),
            ...(text !== '' ? { outputSummary: toSummary(text) } : {}),
            ...(payloadRef !== undefined ? { payloadRef } : {}),
          };
          events.push(closeEv);
          openNow.delete(open.key);
          // A closed Task span is the observed end of its (synchronously
          // joined) subagent: close the sidechain's dangling turn with the
          // same end time instead of leaving it to EOF cleanup.
          const joinedAgent = agentByToolUseId.get(b.toolUseId);
          if (joinedAgent !== undefined && stateFor(joinedAgent).turnKey !== undefined) {
            closeTurn(joinedAgent, item.tsMs);
          }
        }
      } else {
        const text = msg?.text ?? '';
        const notificationToken =
          text.includes('<task-notification>')
            ? [...detachedTokens.entries()].filter(([, token]) => text.includes(token))
            : [];
        if (notificationToken.length > 0) {
          // Async Task notification: event on the current main turn + NOTIFY
          // link from the Task span to the detached sidechain root.
          for (const [toolUseId, token] of notificationToken) {
            const mainState = stateFor(MAIN_AGENT);
            if (mainState.turnKey !== undefined) {
              events.push({
                type: 'span.event',
                key: mainState.turnKey,
                event: { name: 'claude_code.task_notification', timestampMs: item.tsMs, attributes: { taskId: token } },
              });
            }
            const agentId = agentByToolUseId.get(toolUseId);
            if (agentId !== undefined) {
              const linkKey = `${toolUseId}->${agentId}`;
              if (!emittedLinks.has(linkKey)) {
                emittedLinks.add(linkKey);
                pendingLinks.push({ fromKey: `tool:${MAIN_AGENT}:${toolUseId}`, toKey: `turn:${agentId}:0` });
              }
            }
          }
        } else {
          // Real user prompt: close any dangling turn, open a new one.
          if (s.turnKey !== undefined) closeTurn(agentKey, item.tsMs);
          if (text !== '') s.lastUserText = text;
          openTurn(agentKey, item);
        }
      }
    } else if (type === 'assistant') {
      const msg = viewMessage(row.message);
      if (msg !== undefined) {
        countRow();
        // LLM_CALL: one per assistant row. Duration is inferred from the
        // previous row of the same agent (approx: true).
        const startMs = s.lastTsMs !== undefined && s.lastTsMs <= item.tsMs ? s.lastTsMs : item.tsMs;
        const attributes: Record<string, SpanAttributeValue> = {
          ...agentAttrs(agentKey),
          ...rootJoinAttrs(agentKey),
          [ATTR.APPROX]: true,
        };
        if (msg.model !== undefined) attributes[ATTR.GEN_AI_MODEL] = msg.model;
        const tokenUsage = msg.usage !== undefined ? toTokenUsage(msg.usage) : undefined;
        const parentKey = currentParentKey(agentKey);
        const llmKey = `llm:${item.rowKey}`;
        const openEv: RawEvent = {
          type: 'span.open',
          key: llmKey,
          ...(parentKey !== undefined ? { parentKey } : {}),
          sourceRowKey: item.rowKey,
          kind: 'LLM_CALL',
          name: msg.model ?? 'llm',
          startTimeMs: startMs,
          attributes,
          ...(s.lastUserText !== undefined && s.lastUserText !== '' ? { inputSummary: toSummary(s.lastUserText) } : {}),
        };
        openSpan(openEv);
        const closeEv: RawEvent = {
          type: 'span.close',
          key: llmKey,
          endTimeMs: item.tsMs,
          ...(msg.text !== '' ? { outputSummary: toSummary(msg.text) } : {}),
          ...(tokenUsage !== undefined ? { tokenUsage } : {}),
        };
        events.push(closeEv);
        openNow.delete(llmKey);
        // TOOL_CALL spans open on tool_use blocks.
        for (const b of msg.blocks ?? []) {
          if (b.type !== 'tool_use' || b.id === undefined || b.name === undefined) continue;
          const key = `tool:${agentKey}:${b.id}`;
          const inputSummary = 'input' in b ? toSummary(safeJson(b.input)) : undefined;
          let payloadRef: string | undefined;
          if (payloadStore !== undefined) {
            payloadRef = payloadStore.put({ tool: b.name, input: b.input ?? null });
          }
          const toolParent = currentParentKey(agentKey);
          const toolAttrs: Record<string, SpanAttributeValue> = { ...agentAttrs(agentKey) };
          openSpan({
            type: 'span.open',
            key,
            ...(toolParent !== undefined ? { parentKey: toolParent } : {}),
            sourceRowKey: `${item.rowKey}#tool:${b.id}`,
            kind: 'TOOL_CALL',
            name: b.name,
            startTimeMs: item.tsMs,
            toolName: b.name,
            attributes: toolAttrs,
            ...(inputSummary !== undefined && inputSummary !== '' ? { inputSummary } : {}),
            ...(payloadRef !== undefined ? { payloadRef } : {}),
          });
          s.openTools.set(b.id, { key, toolName: b.name, input: b.input ?? null });
        }
      }
    } else if (type === 'system') {
      if (str(row.subtype) === 'turn_duration') {
        countRow();
        const durationMs = typeof row.durationMs === 'number' ? row.durationMs : undefined;
        if (durationMs !== undefined && s.turnKey !== undefined) {
          const extra: Record<string, SpanAttributeValue> = {};
          const messageCount = typeof row.messageCount === 'number' ? row.messageCount : undefined;
          if (messageCount !== undefined) extra['turn.messageCount'] = messageCount;
          // Authoritative duration: end = turn start + durationMs.
          closeTurn(agentKey, s.turnStartMs + durationMs, extra);
        }
      }
      // other system subtypes (stop_hook_summary, away_summary, ...): ignored
    }
    // user/assistant rows also drive the per-agent "previous row" clock.
    if (type === 'user' || type === 'assistant' || type === 'system') {
      s.lastTsMs = item.tsMs;
    }
  }

  // NOTIFY links last: every endpoint key has been opened by now.
  for (const link of pendingLinks) {
    if (openedKeys.has(link.fromKey) && openedKeys.has(link.toKey)) {
      events.push({ type: 'link', fromKey: link.fromKey, toKey: link.toKey, kind: 'NOTIFY' });
    }
  }

  // The session span is genuinely observed to end at the last row; anything
  // else still open is left for the pipeline's closeAllIncomplete.
  events.push({ type: 'span.close', key: 'session', endTimeMs: lastTsMs });
  openNow.delete('session');

  for (const ev of events) yield ev;
}
