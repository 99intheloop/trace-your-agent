/**
 * kimi-code wire.jsonl → RawEvent translator (v1 + v2, single op table — FORMAT.md §2).
 *
 * Pipeline shape: read every agent wire of the session, merge records in time
 * order (per-file order is preserved by a stable sort), pre-compute subagent
 * join evidence (state.json + Agent/AgentSwarm tool-result text), then emit
 * RawEvents. Turn lifecycle has no explicit end record: a turn closes at its
 * terminal `step.end` (finishReason ≠ 'tool_use'), at `turn.cancel` (error),
 * at the next turn boundary, or stays open for the pipeline's
 * `closeAllIncomplete` (crashed turn, FORMAT.md §4).
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { PayloadStore } from '../../core/payload-store.js';
import { redactString } from '../../core/redact.js';
import type { RawEvent } from '../../core/source.js';
import {
  ATTR,
  toSummary,
  type JoinQuality,
  type SpanAttributeValue,
  type SpanEvent,
  type SpanStatus,
  type TokenUsage,
} from '../../core/types.js';
import { listAgentWires, readSessionState, type SessionState } from './session-dir.js';
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  classifyProtocolVersion,
  parseWireJsonl,
  UnknownWireProtocolError,
  type WireEngine,
  type WireProtocol,
  type WireRecord,
} from './wire.js';

/** Custom attribute keys (semconv-style dotted, `kimi.` namespace). */
export const KIMI_ATTR = {
  ENGINE: 'kimi.engine',
  WIRE_PROTOCOL: 'kimi.wire.protocol_version',
  TURN_INDEX: 'kimi.turn.index',
  TURN_ID: 'kimi.turn.id',
  TURN_ORIGIN: 'kimi.turn.origin',
  TURN_IMPLICIT: 'kimi.turn.implicit',
  STEP: 'kimi.step',
  STEP_FINISH_REASON: 'kimi.step.finish_reason',
  STEP_PROVIDER_FINISH_REASON: 'kimi.step.provider_finish_reason',
  STEP_MESSAGE_ID: 'kimi.step.message_id',
  STEP_HAS_THINKING: 'kimi.step.has_thinking',
  LLM_KIND: 'kimi.llm.kind',
  LLM_PROVIDER: 'kimi.llm.provider',
  LLM_ATTEMPT: 'kimi.llm.attempt',
  LLM_MESSAGE_COUNT: 'kimi.llm.message_count',
  LLM_SYSTEM_PROMPT_HASH: 'kimi.llm.system_prompt_hash',
  LLM_TOOLS_HASH: 'kimi.llm.tools_hash',
  LLM_THINKING_EFFORT: 'kimi.llm.thinking_effort',
  LLM_MODEL_ALIAS: 'kimi.llm.model_alias',
  LLM_FIRST_TOKEN_LATENCY_MS: 'kimi.llm.first_token_latency_ms',
  LLM_STREAM_DURATION_MS: 'kimi.llm.stream_duration_ms',
  LLM_REQUEST_BUILD_MS: 'kimi.llm.request_build_ms',
  LLM_SERVER_FIRST_TOKEN_MS: 'kimi.llm.server_first_token_ms',
  LLM_SERVER_DECODE_MS: 'kimi.llm.server_decode_ms',
  LLM_CLIENT_CONSUME_MS: 'kimi.llm.client_consume_ms',
  TOOL_CALL_ID: 'kimi.tool.call_id',
  NOTIFICATION_TASK_ID: 'kimi.notification.task_id',
  NOTIFICATION_STATUS: 'kimi.notification.status',
  NOTIFICATION_TYPE: 'kimi.notification.type',
  NOTIFICATION_AGENT_ID: 'kimi.notification.agent_id',
} as const;

const SESSION_KEY = 'session';
const MAIN_AGENT_ID = 'main';
const AGENT_TOOL_NAMES = new Set(['Agent', 'AgentSwarm']);

export interface KimiParseOptions {
  /** When present, full message payloads are stored and referenced via payloadRef. */
  readonly payloadStore?: PayloadStore;
}

interface SessionRefLike {
  readonly sessionId: string;
  readonly filePath: string;
}

interface AgentWireData {
  readonly agentId: string;
  readonly filePath: string;
  readonly protocol: WireProtocol;
  readonly metadataCreatedAtMs?: number;
  readonly lines: readonly BusinessLine[];
}

interface BusinessLine {
  readonly record: WireRecord;
  readonly byteOffset: number;
  readonly timeMs: number;
}

interface MergedLine extends BusinessLine {
  readonly agentId: string;
  readonly wireOrder: number;
  readonly seq: number;
}

/** How a subagent attaches to its parent (FORMAT.md §5). */
interface JoinPlan {
  readonly parentId: string;
  readonly toolCallId?: string;
  readonly background: boolean;
  readonly quality: JoinQuality;
}

interface NotificationPlan {
  readonly wireAgentId: string;
  readonly taskId?: string;
  readonly status?: string;
  readonly childId?: string;
}

interface SessionPlan {
  readonly joins: ReadonlyMap<string, JoinPlan>;
  /** Agent tool calls with args.resume — maps resumed agent id → call. */
  readonly resumes: ReadonlyMap<string, { parentId: string; toolCallId: string }>;
  readonly detached: ReadonlySet<string>;
  readonly notifications: readonly NotificationPlan[];
  /** Agents whose wire contains at least one turn.prompt (NOTIFY link target exists). */
  readonly agentsWithTurns: ReadonlySet<string>;
  readonly firstModel?: string;
}

interface TurnState {
  key: string;
  agentId: string;
  index: number;
  pendingCloseMs?: number | undefined;
  lastText?: string;
}

interface StepState {
  key: string;
  agentId: string;
  turnKey: string;
  startMs: number;
  turnId?: string;
  step?: number;
  text: string;
  hasThinking: boolean;
}

interface ToolState {
  key: string;
  agentId: string;
}

/**
 * Parse one kimi-code session directory into RawEvents.
 *
 * `session.filePath` must point at the session's primary wire file
 * (`<sessionDir>/agents/<agentId>/wire.jsonl`); `fromOffset` applies to that
 * file only — the other agents' wires are always re-read in full (span ids are
 * deterministic, so re-emitted rows are harmless).
 *
 * @throws UnknownWireProtocolError when the primary wire's protocol_version is
 *         outside the known 1.x lineage. Other agents' bad wires are skipped.
 */
export async function* parseKimiSession(
  session: SessionRefLike,
  fromOffset: number,
  options: KimiParseOptions = {},
): AsyncIterable<RawEvent> {
  // filePath = <sessionDir>/agents/<agentId>/wire.jsonl → three dirnames up.
  const sessionDir = dirname(dirname(dirname(session.filePath)));
  const state = await readSessionState(sessionDir);
  const wires = await loadWires(session, sessionDir, fromOffset);
  if (wires.length === 0) return;

  const merged = mergeWires(wires);
  const primary = wires.find((w) => w.filePath === session.filePath);
  if (primary === undefined) return; // unreachable: loadWires always includes filePath
  const engine: WireEngine = state?.metaVersion === 2 ? 'v2' : primary.protocol.engine;
  const startedAtMs =
    primary.metadataCreatedAtMs ??
    wires.map((w) => w.metadataCreatedAtMs).find((v): v is number => v !== undefined) ??
    state?.createdAtMs ??
    0;

  const plan = planSession(wires, merged, state);
  const emitter = new SessionEmitter(
    session.sessionId,
    engine,
    primary.protocol,
    state,
    plan,
    new Set(wires.map((w) => w.agentId)),
    options,
  );
  yield* emitter.run(merged, startedAtMs);
}

/** Read every agent wire; classify protocol; apply fromOffset to the primary wire. */
async function loadWires(
  session: SessionRefLike,
  sessionDir: string,
  fromOffset: number,
): Promise<AgentWireData[]> {
  let wireFiles = await listAgentWires(sessionDir);
  if (!wireFiles.some((w) => w.filePath === session.filePath)) {
    // SessionRef from elsewhere (tests, manual invocation): trust its filePath.
    wireFiles = [
      { agentId: basename(dirname(session.filePath)), filePath: session.filePath },
      ...wireFiles,
    ];
  }

  const out: AgentWireData[] = [];
  for (const wireFile of wireFiles) {
    const isPrimary = wireFile.filePath === session.filePath;
    let buf: Buffer;
    try {
      buf = await readFile(wireFile.filePath);
    } catch (error) {
      if (isPrimary) throw error;
      continue; // unreadable subagent wire: skip, don't fail the session
    }
    const allLines = parseWireJsonl(buf, 0);
    const metadataLine = allLines[0]?.record.type === 'metadata' ? allLines[0].record : undefined;
    const version = asString(metadataLine?.['protocol_version']);
    const protocol = version !== undefined ? classifyProtocolVersion(version) : null;
    if (protocol === null) {
      if (isPrimary) throw new UnknownWireProtocolError(version ?? '<missing metadata>', wireFile.filePath);
      continue; // unknown subagent wire generation: skip it, keep the session
    }
    const metadataCreatedAtMs = asNumber(metadataLine?.['created_at']);

    const lines: BusinessLine[] = [];
    let lastTime = metadataCreatedAtMs ?? 0;
    for (const line of allLines) {
      if (line.record.type === 'metadata') continue;
      if (isPrimary && line.byteOffset < fromOffset) continue;
      const timeMs = asNumber(line.record.time) ?? lastTime;
      lastTime = timeMs;
      lines.push({ record: line.record, byteOffset: line.byteOffset, timeMs });
    }
    const wire: {
      agentId: string;
      filePath: string;
      protocol: WireProtocol;
      metadataCreatedAtMs?: number;
      lines: readonly BusinessLine[];
    } = { agentId: wireFile.agentId, filePath: wireFile.filePath, protocol, lines };
    if (metadataCreatedAtMs !== undefined) wire.metadataCreatedAtMs = metadataCreatedAtMs;
    out.push(wire);
  }
  return out;
}

/** Stable time-order merge across agent wires; per-file order is preserved. */
function mergeWires(wires: readonly AgentWireData[]): MergedLine[] {
  const merged: MergedLine[] = [];
  wires.forEach((wire, wireOrder) => {
    wire.lines.forEach((line, seq) => {
      merged.push({ ...line, agentId: wire.agentId, wireOrder, seq });
    });
  });
  merged.sort((a, b) => a.timeMs - b.timeMs || a.wireOrder - b.wireOrder || a.seq - b.seq);
  return merged;
}

// ---------------------------------------------------------------------------
// Pre-pass: subagent join evidence, detached agents, notifications.
// ---------------------------------------------------------------------------

const AGENT_ID_TEXT_RE = /agent_id:\s*([A-Za-z0-9._-]+)/g;
const AGENT_ID_XML_RE = /agent_id="([^"]+)"/g;
const NOTIFICATION_TYPE_RE = /<notification\s[^>]*\btype="([^"]+)"/;

/** Extract validated agent ids mentioned in a tool result / notification text. */
function extractAgentIds(
  text: string,
  knownAgents: ReadonlySet<string>,
  exclude: string,
): string[] {
  const found: string[] = [];
  for (const re of [AGENT_ID_TEXT_RE, AGENT_ID_XML_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const id = match[1];
      if (id !== undefined && knownAgents.has(id) && id !== exclude && !found.includes(id)) {
        found.push(id);
      }
    }
  }
  return found;
}

function planSession(
  wires: readonly AgentWireData[],
  merged: readonly MergedLine[],
  state: SessionState | undefined,
): SessionPlan {
  const knownAgents = new Set<string>(wires.map((w) => w.agentId));
  for (const id of Object.keys(state?.agents ?? {})) knownAgents.add(id);

  const joins = new Map<string, JoinPlan>();
  const resumes = new Map<string, { parentId: string; toolCallId: string }>();
  const detached = new Set<string>();
  const notifications: NotificationPlan[] = [];
  const agentsWithTurns = new Set<string>();
  let firstModel: string | undefined;

  // 1. Structural evidence from state.json parentAgentId (FORMAT.md §5 ①).
  for (const [agentId, meta] of Object.entries(state?.agents ?? {})) {
    if (agentId === MAIN_AGENT_ID) continue;
    if (meta.parentAgentId !== undefined && meta.parentAgentId !== agentId) {
      joins.set(agentId, { parentId: meta.parentAgentId, background: false, quality: 'semi' });
    }
  }

  // 2. Tool-result text evidence (FORMAT.md §5 ②): Agent/AgentSwarm calls paired
  //    with their results inside one wire, `agent_id` extracted from the output.
  const spawnCalls: Array<{
    parentId: string;
    toolCallId: string;
    timeMs: number;
    resultTimeMs?: number;
  }> = [];
  for (const wire of wires) {
    const openCalls = new Map<string, { name: string; args: unknown; timeMs: number }>();
    for (const line of wire.lines) {
      const { record } = line;
      if (record.type === 'turn.prompt') agentsWithTurns.add(wire.agentId);
      if (record.type === 'llm.request' && firstModel === undefined) {
        firstModel = asString(record['model']);
      }
      if (record.type === 'context.append_loop_event') {
        const event = asObject(record['event']);
        if (event === undefined) continue;
        if (event['type'] === 'tool.call') {
          const toolCallId = asString(event['toolCallId']);
          const name = asString(event['name']);
          if (toolCallId !== undefined && name !== undefined && AGENT_TOOL_NAMES.has(name)) {
            openCalls.set(toolCallId, { name, args: event['args'], timeMs: line.timeMs });
          }
        } else if (event['type'] === 'tool.result') {
          const toolCallId = asString(event['toolCallId']);
          const call = toolCallId !== undefined ? openCalls.get(toolCallId) : undefined;
          if (call === undefined || toolCallId === undefined) continue;
          openCalls.delete(toolCallId);
          const output = asString(asObject(event['result'])?.['output']) ?? '';
          for (const childId of extractAgentIds(output, knownAgents, wire.agentId)) {
            const args = asObject(call.args);
            const background = asBoolean(args?.['run_in_background']) === true;
            joins.set(childId, {
              parentId: wire.agentId,
              toolCallId,
              background,
              quality: 'semi',
            });
            if (background) detached.add(childId);
            spawnCalls.push({ parentId: wire.agentId, toolCallId, timeMs: call.timeMs, resultTimeMs: line.timeMs });
          }
        }
      }
      // Agent(resume="agent-N") calls pair a later turn of that agent with this call.
      if (record.type === 'context.append_loop_event') {
        const event = asObject(record['event']);
        if (event?.['type'] === 'tool.call' && asString(event['name']) === 'Agent') {
          const resumeId = asString(asObject(event['args'])?.['resume']);
          const toolCallId = asString(event['toolCallId']);
          if (resumeId !== undefined && toolCallId !== undefined && knownAgents.has(resumeId)) {
            resumes.set(resumeId, { parentId: wire.agentId, toolCallId });
          }
        }
      }
      // Background-task notifications (context.append_message or turn.steer).
      if (record.type === 'context.append_message' || record.type === 'turn.steer') {
        const payload =
          record.type === 'context.append_message' ? asObject(record['message']) : record;
        const origin = asObject(payload?.['origin']);
        if (origin?.['kind'] !== 'background_task') continue;
        const content = record.type === 'context.append_message' ? payload?.['content'] : payload?.['input'];
        const text = contentPartsText(content);
        const childId = extractAgentIds(text, knownAgents, wire.agentId)[0];
        const plan: { wireAgentId: string; taskId?: string; status?: string; childId?: string } = {
          wireAgentId: wire.agentId,
        };
        const taskId = asString(origin['taskId']);
        if (taskId !== undefined) plan.taskId = taskId;
        const status = asString(origin['status']);
        if (status !== undefined) plan.status = status;
        if (childId !== undefined) {
          plan.childId = childId;
          detached.add(childId);
        }
        notifications.push(plan);
      }
    }
  }

  // 3. Heuristic fallback: a child wire with no state/text evidence whose first
  //    record falls inside exactly one Agent-tool call window (FORMAT.md §5,
  //    pure timing → 'heuristic').
  for (const wire of wires) {
    if (wire.agentId === MAIN_AGENT_ID || joins.has(wire.agentId)) continue;
    const firstTime = wire.lines[0]?.timeMs;
    if (firstTime === undefined) continue;
    const candidates = spawnCalls.filter(
      (call) => firstTime >= call.timeMs && (call.resultTimeMs === undefined || firstTime <= call.resultTimeMs),
    );
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only !== undefined) {
      joins.set(wire.agentId, {
        parentId: only.parentId,
        toolCallId: only.toolCallId,
        background: false,
        quality: 'heuristic',
      });
    }
  }

  const plan: {
    joins: ReadonlyMap<string, JoinPlan>;
    resumes: ReadonlyMap<string, { parentId: string; toolCallId: string }>;
    detached: ReadonlySet<string>;
    notifications: readonly NotificationPlan[];
    agentsWithTurns: ReadonlySet<string>;
    firstModel?: string;
  } = { joins, resumes, detached, notifications, agentsWithTurns };
  if (firstModel !== undefined) plan.firstModel = firstModel;
  return plan;
}

// ---------------------------------------------------------------------------
// Emit pass.
// ---------------------------------------------------------------------------

class SessionEmitter {
  private readonly events: RawEvent[] = [];
  private readonly openTurns = new Map<string, TurnState>();
  private readonly turnCounters = new Map<string, number>();
  private readonly steps = new Map<string, StepState>();
  private readonly tools = new Map<string, ToolState>();
  private lastTimeMs = 0;

  constructor(
    private readonly sessionId: string,
    private readonly engine: WireEngine,
    private readonly protocol: WireProtocol,
    private readonly state: SessionState | undefined,
    private readonly plan: SessionPlan,
    private readonly wireAgentIds: ReadonlySet<string>,
    private readonly options: KimiParseOptions,
  ) {}

  *run(merged: readonly MergedLine[], startedAtMs: number): Generator<RawEvent> {
    this.lastTimeMs = startedAtMs;

    const metaAttributes: Record<string, SpanAttributeValue> = {
      [KIMI_ATTR.ENGINE]: this.engine,
      [KIMI_ATTR.WIRE_PROTOCOL]: this.protocol.version,
    };
    if (this.plan.firstModel !== undefined) {
      metaAttributes[ATTR.GEN_AI_MODEL] = this.plan.firstModel;
    }
    const meta: {
      type: 'session.meta';
      cwd?: string;
      startedAtMs?: number;
      attributes: Record<string, SpanAttributeValue>;
    } = { type: 'session.meta', attributes: metaAttributes };
    if (this.state?.workDir !== undefined) meta.cwd = this.state.workDir;
    if (startedAtMs > 0) meta.startedAtMs = startedAtMs;
    this.emit(meta);

    const sessionAttributes: Record<string, SpanAttributeValue> = {
      [ATTR.SESSION_ID]: this.sessionId,
      [ATTR.SOURCE]: 'kimi-code',
      [KIMI_ATTR.ENGINE]: this.engine,
      [KIMI_ATTR.WIRE_PROTOCOL]: this.protocol.version,
    };
    if (this.plan.firstModel !== undefined) {
      sessionAttributes[ATTR.GEN_AI_MODEL] = this.plan.firstModel;
    }
    if (this.wireAgentIds.has(MAIN_AGENT_ID)) sessionAttributes[ATTR.AGENT_ID] = MAIN_AGENT_ID;
    this.emit({
      type: 'span.open',
      key: SESSION_KEY,
      sourceRowKey: 'session',
      kind: 'SESSION',
      name: this.state?.title ?? `kimi-code session ${this.sessionId}`,
      startTimeMs: startedAtMs,
      attributes: sessionAttributes,
    });

    for (const line of merged) {
      this.lastTimeMs = Math.max(this.lastTimeMs, line.timeMs);
      this.dispatch(line);
    }

    // Turns with a terminal step close cleanly; anything still open is left
    // for the pipeline's SpanBuilder.closeAllIncomplete (crashed turn/step).
    for (const turn of this.openTurns.values()) {
      if (turn.pendingCloseMs !== undefined) {
        this.closeTurn(turn, turn.pendingCloseMs, { code: 'ok' });
      }
    }
    this.openTurns.clear();

    this.emit({
      type: 'span.close',
      key: SESSION_KEY,
      endTimeMs: this.lastTimeMs,
      status: { code: 'ok' },
    });
    yield* this.events;
  }

  private emit(event: RawEvent): void {
    this.events.push(event);
  }

  private dispatch(line: MergedLine): void {
    const { record } = line;
    switch (record.type) {
      case 'turn.prompt':
        this.openTurn(line, asString(asObject(record['origin'])?.['kind']), record['input'], false);
        return;
      case 'turn.steer': {
        const origin = asObject(record['origin']);
        const originKind = asString(origin?.['kind']);
        if (originKind === 'background_task') {
          // Background-task completion notice carried by a steer (FORMAT.md §5):
          // it may launch a fresh turn, and it also yields a NOTIFY link.
          if (!this.openTurns.has(line.agentId)) {
            this.openTurn(line, originKind, record['input'], false);
          }
          this.onNotificationMessage(line, { role: 'user', content: record['input'] }, origin ?? {});
          return;
        }
        if (!this.openTurns.has(line.agentId)) {
          // steer while idle launches a new turn.
          this.openTurn(line, originKind, record['input'], false);
        } else {
          this.onSteer(line, originKind);
        }
        return;
      }
      case 'turn.cancel':
        this.onTurnCancel(line);
        return;
      case 'context.append_loop_event':
        this.onLoopEvent(line);
        return;
      case 'context.append_message':
        this.onAppendMessage(line);
        return;
      case 'llm.request':
        this.onLlmRequest(line);
        return;
      default:
        return;
    }
  }

  // --- turns ---------------------------------------------------------------

  private openTurn(
    line: MergedLine,
    originKind: string | undefined,
    input: unknown,
    implicit: boolean,
  ): TurnState {
    const existing = this.openTurns.get(line.agentId);
    if (existing !== undefined) {
      this.closeTurn(existing, existing.pendingCloseMs ?? line.timeMs, { code: 'ok' });
    }
    const index = this.turnCounters.get(line.agentId) ?? 0;
    this.turnCounters.set(line.agentId, index + 1);
    const key = `turn:${line.agentId}:${String(index)}`;

    const attributes: Record<string, SpanAttributeValue> = {
      [ATTR.SESSION_ID]: this.sessionId,
      [ATTR.SOURCE]: 'kimi-code',
      [ATTR.AGENT_ID]: line.agentId,
      [KIMI_ATTR.TURN_INDEX]: index,
    };
    if (originKind !== undefined) attributes[KIMI_ATTR.TURN_ORIGIN] = originKind;
    if (implicit) attributes[KIMI_ATTR.TURN_IMPLICIT] = true;
    if (this.plan.detached.has(line.agentId)) attributes[ATTR.DETACHED] = true;

    const open: {
      type: 'span.open';
      key: string;
      parentKey?: string;
      sourceRowKey: string;
      kind: 'AGENT_TURN';
      name: string;
      startTimeMs: number;
      attributes: Record<string, SpanAttributeValue>;
      inputSummary?: string;
      payloadRef?: string;
    } = {
      type: 'span.open',
      key,
      sourceRowKey: implicit
        ? `${line.agentId}@${String(line.byteOffset)}:turn`
        : `${line.agentId}@${String(line.byteOffset)}`,
      kind: 'AGENT_TURN',
      name: `turn ${String(index + 1)}`,
      startTimeMs: line.timeMs,
      attributes,
    };

    const join = this.decideJoin(line.agentId, index, attributes);
    if (join !== undefined) open.parentKey = join;

    const text = contentPartsText(input);
    if (text.length > 0) open.inputSummary = toSummary(redactString(text));
    if (this.options.payloadStore !== undefined && input !== undefined) {
      open.payloadRef = this.options.payloadStore.put({ input, origin: originKind });
    }
    this.emit(open);

    const turn: TurnState = { key, agentId: line.agentId, index };
    this.openTurns.set(line.agentId, turn);
    return turn;
  }

  /**
   * Parent attachment for a turn (FORMAT.md §5). Mutates `attributes` with
   * agent.parent.id / joinQuality. Returns the parent key, or `undefined` for
   * a true orphan (no evidence at all).
   */
  private decideJoin(
    agentId: string,
    turnIndex: number,
    attributes: Record<string, SpanAttributeValue>,
  ): string | undefined {
    const stateMeta = this.state?.agents?.[agentId];
    if (agentId === MAIN_AGENT_ID || stateMeta?.type === 'independent') {
      attributes[ATTR.JOIN_QUALITY] = 'structural';
      return SESSION_KEY;
    }
    const plan = this.plan.joins.get(agentId);
    const parentId = plan?.parentId ?? stateMeta?.parentAgentId;
    if (parentId !== undefined) attributes[ATTR.AGENT_PARENT_ID] = parentId;

    // A currently-open Agent(resume=...) call pairs any turn of that agent.
    // this.tools is keyed `<agentId>:<toolCallId>` while span keys are
    // `tool:<agentId>:<toolCallId>` — check membership with the former,
    // return the latter as parentKey.
    const resume = this.plan.resumes.get(agentId);
    if (resume !== undefined) {
      if (this.tools.has(`${resume.parentId}:${resume.toolCallId}`)) {
        attributes[ATTR.JOIN_QUALITY] = 'semi';
        return `tool:${resume.parentId}:${resume.toolCallId}`;
      }
    }
    if (plan?.toolCallId !== undefined && turnIndex === 0) {
      attributes[ATTR.JOIN_QUALITY] = plan.quality;
      return this.tools.has(`${plan.parentId}:${plan.toolCallId}`)
        ? `tool:${plan.parentId}:${plan.toolCallId}`
        : SESSION_KEY;
    }
    if (plan !== undefined || parentId !== undefined) {
      attributes[ATTR.JOIN_QUALITY] = plan?.quality ?? 'semi';
      return SESSION_KEY;
    }
    return undefined; // orphan: no parent evidence anywhere
  }

  private closeTurn(turn: TurnState, endTimeMs: number, status: SpanStatus): void {
    const close: {
      type: 'span.close';
      key: string;
      endTimeMs: number;
      status: SpanStatus;
      outputSummary?: string;
    } = { type: 'span.close', key: turn.key, endTimeMs, status };
    if (turn.lastText !== undefined && turn.lastText.length > 0) {
      close.outputSummary = toSummary(redactString(turn.lastText));
    }
    this.emit(close);
    this.openTurns.delete(turn.agentId);
  }

  private onSteer(line: MergedLine, originKind: string | undefined): void {
    const turn = this.openTurns.get(line.agentId);
    if (turn === undefined) return;
    turn.pendingCloseMs = undefined;
    const event: SpanEvent = { name: 'steer', timestampMs: line.timeMs };
    const attributes: Record<string, SpanAttributeValue> = {};
    if (originKind !== undefined) attributes[KIMI_ATTR.TURN_ORIGIN] = originKind;
    if (this.options.payloadStore !== undefined) {
      attributes['payload_ref'] = this.options.payloadStore.put({
        input: line.record['input'],
        origin: originKind,
      });
    }
    if (Object.keys(attributes).length > 0) event.attributes = attributes;
    this.emit({ type: 'span.event', key: turn.key, event });
  }

  private onTurnCancel(line: MergedLine): void {
    const turn = this.openTurns.get(line.agentId);
    if (turn === undefined) return;
    const status: SpanStatus = { code: 'error', message: 'turn.cancel' };
    // Interrupt anything still in flight inside this turn.
    for (const [key, step] of [...this.steps.entries()]) {
      if (step.agentId === line.agentId) {
        this.emit({ type: 'span.close', key: step.key, endTimeMs: line.timeMs, status });
        this.steps.delete(key);
      }
    }
    for (const [key, tool] of [...this.tools.entries()]) {
      if (tool.agentId === line.agentId) {
        this.emit({ type: 'span.close', key: tool.key, endTimeMs: line.timeMs, status });
        this.tools.delete(key);
      }
    }
    this.closeTurn(turn, line.timeMs, status);
  }

  // --- loop events (steps / tools / content) --------------------------------

  private onLoopEvent(line: MergedLine): void {
    const event = asObject(line.record['event']);
    if (event === undefined) return;
    switch (event['type']) {
      case 'step.begin':
        this.onStepBegin(line, event);
        return;
      case 'step.end':
        this.onStepEnd(line, event);
        return;
      case 'content.part':
        this.onContentPart(line, event);
        return;
      case 'tool.call':
        this.onToolCall(line, event);
        return;
      case 'tool.result':
        this.onToolResult(line, event);
        return;
      default:
        return;
    }
  }

  private onStepBegin(line: MergedLine, event: Record<string, unknown>): void {
    let turn = this.openTurns.get(line.agentId);
    if (turn === undefined) {
      // Resume-from-offset can land mid-turn: open an implicit turn so the
      // step has a parent (marked kimi.turn.implicit).
      turn = this.openTurn(line, undefined, undefined, true);
    }
    turn.pendingCloseMs = undefined;

    const uuid = asString(event['uuid']) ?? `no-uuid@${String(line.byteOffset)}`;
    const key = `step:${line.agentId}:${uuid}`;
    const step = asNumber(event['step']);
    const turnId = asString(event['turnId']);
    const attributes: Record<string, SpanAttributeValue> = {
      [ATTR.SESSION_ID]: this.sessionId,
      [ATTR.SOURCE]: 'kimi-code',
      [ATTR.AGENT_ID]: line.agentId,
      [ATTR.JOIN_QUALITY]: 'structural',
    };
    if (step !== undefined) attributes[KIMI_ATTR.STEP] = step;
    if (turnId !== undefined) attributes[KIMI_ATTR.TURN_ID] = turnId;
    if (this.plan.detached.has(line.agentId)) attributes[ATTR.DETACHED] = true;
    this.emit({
      type: 'span.open',
      key,
      parentKey: turn.key,
      sourceRowKey: `${line.agentId}@${String(line.byteOffset)}`,
      kind: 'LLM_CALL',
      name: step !== undefined ? `step ${String(step)}` : 'step',
      startTimeMs: line.timeMs,
      attributes,
    });
    const state: StepState = { key, agentId: line.agentId, turnKey: turn.key, startMs: line.timeMs, text: '', hasThinking: false };
    if (turnId !== undefined) state.turnId = turnId;
    if (step !== undefined) state.step = step;
    this.steps.set(`${line.agentId}:${uuid}`, state);
  }

  private onStepEnd(line: MergedLine, event: Record<string, unknown>): void {
    const uuid = asString(event['uuid']);
    const state = uuid !== undefined ? this.steps.get(`${line.agentId}:${uuid}`) : undefined;
    if (state === undefined) return;
    this.steps.delete(`${line.agentId}:${uuid}`);

    const attributes: Record<string, SpanAttributeValue> = {};
    const events: SpanEvent[] = [];
    const finishReason = asString(event['finishReason']);
    if (finishReason !== undefined) attributes[KIMI_ATTR.STEP_FINISH_REASON] = finishReason;
    const providerFinishReason = asString(event['providerFinishReason']);
    if (providerFinishReason !== undefined) {
      attributes[KIMI_ATTR.STEP_PROVIDER_FINISH_REASON] = providerFinishReason;
    }
    const messageId = asString(event['messageId']);
    if (messageId !== undefined) attributes[KIMI_ATTR.STEP_MESSAGE_ID] = messageId;
    if (state.hasThinking) attributes[KIMI_ATTR.STEP_HAS_THINKING] = true;

    // Precise latency split (FORMAT.md §4): raw values as attributes plus
    // first_token / stream_end span events positioned inside the step window.
    const firstToken = asNumber(event['llmFirstTokenLatencyMs']);
    const streamDuration = asNumber(event['llmStreamDurationMs']);
    const requestBuild = asNumber(event['llmRequestBuildMs']);
    const serverFirstToken = asNumber(event['llmServerFirstTokenMs']);
    const serverDecode = asNumber(event['llmServerDecodeMs']);
    const clientConsume = asNumber(event['llmClientConsumeMs']);
    if (firstToken !== undefined) attributes[KIMI_ATTR.LLM_FIRST_TOKEN_LATENCY_MS] = firstToken;
    if (streamDuration !== undefined) attributes[KIMI_ATTR.LLM_STREAM_DURATION_MS] = streamDuration;
    if (requestBuild !== undefined) attributes[KIMI_ATTR.LLM_REQUEST_BUILD_MS] = requestBuild;
    if (serverFirstToken !== undefined) attributes[KIMI_ATTR.LLM_SERVER_FIRST_TOKEN_MS] = serverFirstToken;
    if (serverDecode !== undefined) attributes[KIMI_ATTR.LLM_SERVER_DECODE_MS] = serverDecode;
    if (clientConsume !== undefined) attributes[KIMI_ATTR.LLM_CLIENT_CONSUME_MS] = clientConsume;
    if (firstToken !== undefined) {
      const attrs: Record<string, SpanAttributeValue> = { latency_ms: firstToken };
      if (requestBuild !== undefined) attrs['request_build_ms'] = requestBuild;
      if (serverFirstToken !== undefined) attrs['server_first_token_ms'] = serverFirstToken;
      events.push({ name: 'first_token', timestampMs: state.startMs + firstToken, attributes: attrs });
    }
    if (firstToken !== undefined && streamDuration !== undefined) {
      const attrs: Record<string, SpanAttributeValue> = { stream_duration_ms: streamDuration };
      if (serverDecode !== undefined) attrs['server_decode_ms'] = serverDecode;
      if (clientConsume !== undefined) attrs['client_consume_ms'] = clientConsume;
      events.push({
        name: 'stream_end',
        timestampMs: state.startMs + firstToken + streamDuration,
        attributes: attrs,
      });
    }

    const close: {
      type: 'span.close';
      key: string;
      endTimeMs: number;
      status: SpanStatus;
      attributes: Record<string, SpanAttributeValue>;
      events?: SpanEvent[];
      tokenUsage?: TokenUsage;
      outputSummary?: string;
    } = {
      type: 'span.close',
      key: state.key,
      endTimeMs: line.timeMs,
      status: { code: 'ok' },
      attributes,
    };
    if (events.length > 0) close.events = events;
    const tokenUsage = mapKosongUsage(event['usage']);
    if (tokenUsage !== undefined) close.tokenUsage = tokenUsage;
    if (state.text.length > 0) close.outputSummary = toSummary(redactString(state.text));
    this.emit(close);

    if (finishReason !== undefined && finishReason !== 'tool_use') {
      // Terminal for the turn unless a hook continues it (a later step.begin
      // clears pendingCloseMs — FORMAT.md §4).
      const turn = this.openTurns.get(line.agentId);
      if (turn !== undefined && turn.key === state.turnKey) {
        turn.pendingCloseMs = line.timeMs;
        if (state.text.length > 0) turn.lastText = state.text;
      }
    }
  }

  private onContentPart(line: MergedLine, event: Record<string, unknown>): void {
    const stepUuid = asString(event['stepUuid']);
    const state = stepUuid !== undefined ? this.steps.get(`${line.agentId}:${stepUuid}`) : undefined;
    if (state === undefined) return;
    const part = asObject(event['part']);
    if (part === undefined) return;
    if (part['type'] === 'text') {
      const text = asString(part['text']);
      if (text !== undefined) state.text += text;
    } else if (part['type'] === 'think') {
      state.hasThinking = true;
    }
  }

  private onToolCall(line: MergedLine, event: Record<string, unknown>): void {
    const toolCallId = asString(event['toolCallId']) ?? `no-id@${String(line.byteOffset)}`;
    const name = asString(event['name']) ?? 'unknown';
    const stepUuid = asString(event['stepUuid']);
    const stepState = stepUuid !== undefined ? this.steps.get(`${line.agentId}:${stepUuid}`) : undefined;
    const parentKey = stepState?.key ?? this.openTurns.get(line.agentId)?.key ?? SESSION_KEY;

    const key = `tool:${line.agentId}:${toolCallId}`;
    const attributes: Record<string, SpanAttributeValue> = {
      [ATTR.SESSION_ID]: this.sessionId,
      [ATTR.SOURCE]: 'kimi-code',
      [ATTR.AGENT_ID]: line.agentId,
      [ATTR.JOIN_QUALITY]: 'structural',
      [KIMI_ATTR.TOOL_CALL_ID]: toolCallId,
    };
    if (this.plan.detached.has(line.agentId)) attributes[ATTR.DETACHED] = true;
    const open: {
      type: 'span.open';
      key: string;
      parentKey: string;
      sourceRowKey: string;
      kind: 'TOOL_CALL';
      name: string;
      startTimeMs: number;
      attributes: Record<string, SpanAttributeValue>;
      toolName: string;
      inputSummary?: string;
    } = {
      type: 'span.open',
      key,
      parentKey,
      sourceRowKey: `${line.agentId}@${String(line.byteOffset)}`,
      kind: 'TOOL_CALL',
      name,
      startTimeMs: line.timeMs,
      attributes,
      toolName: name,
    };
    const argsText = jsonSummary(event['args']);
    if (argsText !== undefined) open.inputSummary = argsText;
    this.emit(open);
    this.tools.set(`${line.agentId}:${toolCallId}`, { key, agentId: line.agentId });
  }

  private onToolResult(line: MergedLine, event: Record<string, unknown>): void {
    const toolCallId = asString(event['toolCallId']);
    const state = toolCallId !== undefined ? this.tools.get(`${line.agentId}:${toolCallId}`) : undefined;
    // A result for an unknown id is dropped (matches kimi's own reader).
    if (state === undefined || toolCallId === undefined) return;
    this.tools.delete(`${line.agentId}:${toolCallId}`);
    const result = asObject(event['result']);
    const output = asString(result?.['output']) ?? '';
    const isError = asBoolean(result?.['isError']) === true;
    const close: {
      type: 'span.close';
      key: string;
      endTimeMs: number;
      status: SpanStatus;
      outputSummary?: string;
    } = {
      type: 'span.close',
      key: state.key,
      endTimeMs: line.timeMs,
      status: isError ? { code: 'error', message: 'tool result isError' } : { code: 'ok' },
    };
    if (output.length > 0) close.outputSummary = toSummary(redactString(output));
    this.emit(close);
  }

  // --- llm.request backfill ---------------------------------------------------

  private onLlmRequest(line: MergedLine): void {
    const record = line.record;
    const model = asString(record['model']);
    const provider = asString(record['provider']);
    // NOTE: llm.request carries request metadata only, never a body — no
    // payloadRef is attached here (FORMAT.md §3).
    const target = this.matchStep(line.agentId, asString(record['turnStep']));
    if (target === undefined) return; // e.g. compaction requests have no step
    const attributes: Record<string, SpanAttributeValue> = {};
    if (model !== undefined) attributes[ATTR.GEN_AI_MODEL] = model;
    if (provider !== undefined) attributes[KIMI_ATTR.LLM_PROVIDER] = provider;
    const kind = asString(record['kind']);
    if (kind !== undefined) attributes[KIMI_ATTR.LLM_KIND] = kind;
    const attempt = asString(record['attempt']);
    if (attempt !== undefined) attributes[KIMI_ATTR.LLM_ATTEMPT] = attempt;
    const messageCount = asNumber(record['messageCount']);
    if (messageCount !== undefined) attributes[KIMI_ATTR.LLM_MESSAGE_COUNT] = messageCount;
    const systemPromptHash = asString(record['systemPromptHash']);
    if (systemPromptHash !== undefined) attributes[KIMI_ATTR.LLM_SYSTEM_PROMPT_HASH] = systemPromptHash;
    const toolsHash = asString(record['toolsHash']);
    if (toolsHash !== undefined) attributes[KIMI_ATTR.LLM_TOOLS_HASH] = toolsHash;
    const thinkingEffort = asString(record['thinkingEffort']);
    if (thinkingEffort !== undefined) attributes[KIMI_ATTR.LLM_THINKING_EFFORT] = thinkingEffort;
    const modelAlias = asString(record['modelAlias']);
    if (modelAlias !== undefined) attributes[KIMI_ATTR.LLM_MODEL_ALIAS] = modelAlias;
    if (Object.keys(attributes).length > 0) {
      this.emit({ type: 'span.attr', key: target.key, attributes });
    }
    const eventAttributes: Record<string, SpanAttributeValue> = {};
    if (attempt !== undefined) eventAttributes['attempt'] = attempt;
    if (messageCount !== undefined) eventAttributes['message_count'] = messageCount;
    const event: SpanEvent = { name: 'llm.request', timestampMs: line.timeMs };
    if (Object.keys(eventAttributes).length > 0) event.attributes = eventAttributes;
    this.emit({ type: 'span.event', key: target.key, event });
  }

  /** Match `turnStep` ("<turnId>.<step>", FORMAT.md §3) to an open step. */
  private matchStep(agentId: string, turnStep: string | undefined): StepState | undefined {
    if (turnStep === undefined) return undefined;
    const dot = turnStep.lastIndexOf('.');
    if (dot <= 0) return undefined;
    const turnId = turnStep.slice(0, dot);
    const step = Number(turnStep.slice(dot + 1));
    if (!Number.isFinite(step)) return undefined;
    let found: StepState | undefined;
    for (const state of this.steps.values()) {
      if (state.agentId !== agentId) continue;
      if (state.step !== step || state.turnId !== turnId) continue;
      if (found !== undefined) return undefined; // ambiguous: don't guess
      found = state;
    }
    return found;
  }

  // --- messages & notifications ----------------------------------------------

  private onAppendMessage(line: MergedLine): void {
    const message = asObject(line.record['message']);
    if (message === undefined) return;
    const origin = asObject(message['origin']);
    const originKind = asString(origin?.['kind']);
    if (originKind === 'background_task') {
      this.onNotificationMessage(line, message, origin ?? {});
      return;
    }
    const turn = this.openTurns.get(line.agentId);
    if (turn === undefined) return; // message outside any turn: nothing to hang it on
    const role = asString(message['role']);
    const attributes: Record<string, SpanAttributeValue> = {};
    if (role !== undefined) attributes['role'] = role;
    if (originKind !== undefined) attributes[KIMI_ATTR.TURN_ORIGIN] = originKind;
    if (this.options.payloadStore !== undefined) {
      attributes['payload_ref'] = this.options.payloadStore.put({
        role: role ?? 'user',
        content: message['content'],
        origin,
      });
    }
    const event: SpanEvent = { name: 'message', timestampMs: line.timeMs };
    if (Object.keys(attributes).length > 0) event.attributes = attributes;
    this.emit({ type: 'span.event', key: turn.key, event });
  }

  /** Background-task completion notice (FORMAT.md §5): event + NOTIFY link. */
  private onNotificationMessage(
    line: MergedLine,
    message: Record<string, unknown>,
    origin: Record<string, unknown>,
  ): void {
    const turn = this.openTurns.get(line.agentId);
    const taskId = asString(origin['taskId']);
    const status = asString(origin['status']);
    const text = contentPartsText(message['content']);
    const knownChild = this.plan.notifications.find(
      (n) => n.wireAgentId === line.agentId && n.taskId === taskId && n.childId !== undefined,
    );
    const childId = knownChild?.childId;

    const attributes: Record<string, SpanAttributeValue> = {};
    if (taskId !== undefined) attributes[KIMI_ATTR.NOTIFICATION_TASK_ID] = taskId;
    if (status !== undefined) attributes[KIMI_ATTR.NOTIFICATION_STATUS] = status;
    const notifType = NOTIFICATION_TYPE_RE.exec(text)?.[1];
    if (notifType !== undefined) attributes[KIMI_ATTR.NOTIFICATION_TYPE] = notifType;
    if (childId !== undefined) attributes[KIMI_ATTR.NOTIFICATION_AGENT_ID] = childId;
    if (this.options.payloadStore !== undefined) {
      attributes['payload_ref'] = this.options.payloadStore.put({
        role: asString(message['role']) ?? 'user',
        content: message['content'],
        origin,
      });
    }
    const event: SpanEvent = { name: 'notification', timestampMs: line.timeMs };
    if (Object.keys(attributes).length > 0) event.attributes = attributes;
    this.emit({ type: 'span.event', key: turn?.key ?? SESSION_KEY, event });

    if (childId !== undefined && this.plan.agentsWithTurns.has(childId)) {
      const join = this.plan.joins.get(childId);
      const fromKey =
        join?.toolCallId !== undefined
          ? `tool:${join.parentId}:${join.toolCallId}`
          : (turn?.key ?? SESSION_KEY);
      this.emit({ type: 'link', fromKey, toKey: `turn:${childId}:0`, kind: 'NOTIFY' });
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/** Concatenate the text parts of a ContentPart[] / message content value. */
function contentPartsText(content: unknown): string {
  const direct = asString(content);
  if (direct !== undefined) return direct;
  const parts = asArray(content);
  if (parts === undefined) return '';
  const texts: string[] = [];
  for (const part of parts) {
    const obj = asObject(part);
    if (obj?.['type'] !== 'text') continue;
    const text = asString(obj['text']);
    if (text !== undefined) texts.push(text);
  }
  return texts.join('\n');
}

/** Redacted, length-capped JSON summary of a tool args value. */
function jsonSummary(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  const text = typeof args === 'string' ? args : JSON.stringify(args);
  if (text === undefined || text.length === 0) return undefined;
  return toSummary(redactString(text));
}

/** kosong TokenUsage → normalized TokenUsage (FORMAT.md §3). */
function mapKosongUsage(usage: unknown): TokenUsage | undefined {
  const obj = asObject(usage);
  if (obj === undefined) return undefined;
  const inputOther = asNumber(obj['inputOther']) ?? 0;
  const output = asNumber(obj['output']) ?? 0;
  const cacheRead = asNumber(obj['inputCacheRead']) ?? 0;
  const cacheCreation = asNumber(obj['inputCacheCreation']) ?? 0;
  if (inputOther === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) return undefined;
  const result: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } = {
    inputTokens: inputOther + cacheRead + cacheCreation,
    outputTokens: output,
  };
  if (cacheRead > 0) result.cacheReadTokens = cacheRead;
  if (cacheCreation > 0) result.cacheWriteTokens = cacheCreation;
  return result;
}
