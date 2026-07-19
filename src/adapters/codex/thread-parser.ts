import type { RawEvent } from '../../core/source.js';
import {
  ATTR,
  toSummary,
  type SpanAttributeValue,
  type SpanEvent,
  type TokenUsage,
} from '../../core/types.js';
import type { PayloadStore } from '../../core/payload-store.js';
import {
  MULTI_AGENT_TOOLS,
  asRecord,
  asString,
  contentText,
  epochSecondsToMs,
  extractLastUsage,
  extractThreadMeta,
  functionOutputText,
  normalizeToolName,
  reasoningText,
  type CodexThreadMeta,
  type RolloutRecord,
  type RolloutUsage,
} from './rollout.js';

/**
 * Phase A — parse ONE Codex rollout file (one thread) into a RawEvent list
 * plus the metadata phase B needs for cross-file graph assembly.
 *
 * Produced spans (all keys prefixed with the thread id so that spliced
 * multi-thread streams never collide):
 * - `SESSION`      one per thread, opened from session_meta (never closed by
 *                  the adapter — rollout files have no session-end record, so
 *                  the pipeline closes it as `incomplete`).
 * - `AGENT_TURN`   task_started → task_complete (turn_aborted → error).
 * - `LLM_CALL`     APPROXIMATED: one span per model-request segment
 *                  (reasoning + following assistant message / function_call
 *                  items, closed at tool output / user input / token_count /
 *                  turn end). Always carries `approx: true`.
 *                  NOTE(extension point): exact per-request spans need the
 *                  opt-in `CODEX_ROLLOUT_TRACE_ROOT` ingest bundle (raw API
 *                  requests); wire that in here when supported.
 * - `TOOL_CALL`    function_call/custom_tool_call/tool_search_call paired with
 *                  their output by `call_id`. Parented to the open LLM segment
 *                  (the call is part of the model's output), else the turn.
 *
 * `spawn_agent` calls get `agent.spawn.*` attributes; the raw arguments of all
 * multi-agent tool calls are kept for phase B's join/detached analysis.
 */

export interface SpawnCallInfo {
  /** call_id of the spawn_agent function_call. */
  callId: string;
  /** Span key of the TOOL_CALL span: `tool:<tid>:<callId>`. */
  toolKey: string;
  startMs: number;
  endMs?: number;
  /** Raw `arguments` JSON text (for nickname/id matching in phase B). */
  argsText: string;
  /** Raw output text, once the function_call_output arrived. */
  outputText?: string;
}

/** collab_agent_spawn_end event, recorded for structural joins (protocol.rs:3978). */
export interface CollabSpawnEnd {
  callId: string;
  newThreadId?: string;
  newAgentNickname?: string;
}

export interface ParsedThread {
  meta: CodexThreadMeta;
  events: RawEvent[];
  sessionKey: string;
  /** sourceRowKey of the SESSION span (session_meta line or first line). */
  sessionRowKey: string;
  spawnCalls: SpawnCallInfo[];
  collabSpawnEnds: CollabSpawnEnd[];
  /** Raw arguments of wait_agent/send_input/send_message/resume_agent calls. */
  waitArgTexts: string[];
  /** Start times (ms) of all task_started turns — used by detached detection. */
  turnStarts: number[];
  firstActivityMs?: number;
  lastActivityMs?: number;
  /** Lines skipped due to malformed JSON. */
  droppedLines: number;
}

export interface ParseThreadOptions {
  /** session.id stamped on every span (the ROOT thread id of the tree). */
  rootSessionId: string;
  /** Thread id to use when the file has no usable session_meta. */
  fallbackThreadId: string;
  /** Records with lineNo < this emit no events (incremental resume; the
   *  session_meta line is still used for identity). Default 0. */
  emitFromLine?: number;
  /** When given, full message/tool contents go to the payload store. */
  payloadStore?: PayloadStore;
}

interface TurnState {
  key: string;
  usage: { input: number; output: number; cacheRead: number };
  sawUsage: boolean;
  userTexts: string[];
  lastAgentText?: string;
}

interface LlmState {
  key: string;
  lastMs: number;
  outputText?: string;
  usage?: RolloutUsage;
}

interface OpenTool {
  key: string;
  name: string;
  callId: string;
  argsText: string;
  startMs: number;
  spawn?: SpawnCallInfo;
}

export function parseThreadRecords(
  records: RolloutRecord[],
  options: ParseThreadOptions,
): ParsedThread {
  const emitFromLine = options.emitFromLine ?? 0;
  const events: RawEvent[] = [];

  let meta: CodexThreadMeta = { threadId: options.fallbackThreadId };
  let metaLineNo = records[0]?.lineNo ?? 0;
  let sawSessionMeta = false;

  // First pass for identity: the session_meta record may sit before
  // `emitFromLine` but we still need the thread id for keys/row keys.
  for (const rec of records) {
    if (rec.type !== 'session_meta') continue;
    const extracted = extractThreadMeta(rec.payload);
    if (extracted !== undefined) {
      meta = extracted;
      metaLineNo = rec.lineNo;
      sawSessionMeta = true;
    }
    break;
  }

  const tid = meta.threadId;
  const sessionKey = `session:${tid}`;
  const sessionRowKey = `${tid}:${metaLineNo}`;
  const rowKey = (rec: RolloutRecord): string => `${tid}:${rec.lineNo}`;

  const store = (obj: unknown): string | undefined => options.payloadStore?.put(obj);

  const result: ParsedThread = {
    meta,
    events,
    sessionKey,
    sessionRowKey,
    spawnCalls: [],
    collabSpawnEnds: [],
    waitArgTexts: [],
    turnStarts: [],
    droppedLines: 0,
  };

  let sessionOpened = false;
  let turn: TurnState | undefined;
  let llm: LlmState | undefined;
  let turnCounter = 0;
  let llmCounter = 0;
  let currentModel: string | undefined;
  const openTools = new Map<string, OpenTool>();

  const ts = (rec: RolloutRecord): number =>
    rec.timestampMs ?? result.lastActivityMs ?? meta.startedAtMs ?? 0;

  function touch(rec: RolloutRecord): number {
    const ms = ts(rec);
    if (result.firstActivityMs === undefined || ms < result.firstActivityMs) {
      result.firstActivityMs = ms;
    }
    if (result.lastActivityMs === undefined || ms > result.lastActivityMs) {
      result.lastActivityMs = ms;
    }
    return ms;
  }

  /** Every span carries the product identity so the store can aggregate. */
  function baseAttributes(): Record<string, SpanAttributeValue> {
    return {
      [ATTR.SESSION_ID]: options.rootSessionId,
      [ATTR.SOURCE]: 'codex',
      [ATTR.AGENT_ID]: tid,
    };
  }

  function openSession(startMs: number): void {
    if (sessionOpened) return;
    sessionOpened = true;
    const attributes: Record<string, SpanAttributeValue> = baseAttributes();
    if (meta.parentThreadId !== undefined) attributes[ATTR.AGENT_PARENT_ID] = meta.parentThreadId;
    if (meta.cliVersion !== undefined) attributes['codex.cliVersion'] = meta.cliVersion;
    if (meta.modelProvider !== undefined) attributes['gen_ai.provider.name'] = meta.modelProvider;
    if (meta.sourceKind !== undefined) attributes['codex.threadSource'] = meta.sourceKind;
    if (meta.originator !== undefined) attributes['codex.originator'] = meta.originator;
    if (meta.depth !== undefined) attributes['agent.depth'] = meta.depth;
    if (meta.agentRole !== undefined) attributes['agent.role'] = meta.agentRole;
    if (meta.forkedFromId !== undefined) attributes['codex.forkedFrom'] = meta.forkedFromId;
    if (meta.multiAgentVersion !== undefined) {
      attributes['codex.multiAgentVersion'] = meta.multiAgentVersion;
    }
    const open: RawEvent = {
      type: 'span.open',
      key: sessionKey,
      sourceRowKey: sessionRowKey,
      kind: 'SESSION',
      name: meta.agentNickname !== undefined ? `codex:${meta.agentNickname}` : `codex:${tid.slice(0, 8)}`,
      startTimeMs: startMs,
      attributes,
      ...(meta.agentNickname !== undefined ? { agentName: meta.agentNickname } : {}),
    };
    events.push(open);
  }

  function closeLlm(endMs: number): void {
    if (llm === undefined) return;
    const close: RawEvent = {
      type: 'span.close',
      key: llm.key,
      endTimeMs: endMs,
      ...(llm.usage !== undefined
        ? {
            tokenUsage: {
              inputTokens: llm.usage.inputTokens,
              outputTokens: llm.usage.outputTokens,
              cacheReadTokens: llm.usage.cachedInputTokens,
            } satisfies TokenUsage,
          }
        : {}),
      ...(llm.outputText !== undefined ? { outputSummary: toSummary(llm.outputText) } : {}),
    };
    events.push(close);
    llm = undefined;
  }

  function ensureLlm(rec: RolloutRecord, startMs: number, inputSummary?: string): LlmState {
    if (llm !== undefined) {
      llm.lastMs = Math.max(llm.lastMs, startMs);
      return llm;
    }
    llmCounter += 1;
    const key = `llm:${tid}:${llmCounter}`;
    const attributes: Record<string, SpanAttributeValue> = {
      ...baseAttributes(),
      [ATTR.APPROX]: true,
    };
    if (currentModel !== undefined) attributes[ATTR.GEN_AI_MODEL] = currentModel;
    const parentKey = turn?.key ?? sessionKey;
    events.push({
      type: 'span.open',
      key,
      parentKey,
      // Synthesized span: suffix keeps the row key unique when one source line
      // both opens the segment and carries a tool call.
      sourceRowKey: `${rowKey(rec)}:llm`,
      kind: 'LLM_CALL',
      name: currentModel !== undefined ? `llm:${currentModel}` : 'llm:approx',
      startTimeMs: startMs,
      attributes,
      ...(inputSummary !== undefined && inputSummary !== '' ? { inputSummary: toSummary(inputSummary) } : {}),
    });
    llm = { key, lastMs: startMs };
    return llm;
  }

  function openTurn(rec: RolloutRecord, startMs: number): void {
    const turnId = asString(rec.payload['turn_id']);
    turnCounter += 1;
    const key = `turn:${tid}:${turnId ?? turnCounter}`;
    turn = { key, usage: { input: 0, output: 0, cacheRead: 0 }, sawUsage: false, userTexts: [] };
    events.push({
      type: 'span.open',
      key,
      parentKey: sessionKey,
      sourceRowKey: rowKey(rec),
      kind: 'AGENT_TURN',
      name: `turn ${turnCounter}`,
      startTimeMs: startMs,
      attributes: baseAttributes(),
    });
  }

  function closeTurn(endMs: number, status?: { code: 'ok' | 'error'; message?: string }): void {
    if (turn === undefined) return;
    const payload: Record<string, unknown> = {};
    if (turn.userTexts.length > 0) payload['user'] = turn.userTexts.join('\n');
    if (turn.lastAgentText !== undefined) payload['assistant'] = turn.lastAgentText;
    const payloadRef = Object.keys(payload).length > 0 ? store(payload) : undefined;
    const close: RawEvent = {
      type: 'span.close',
      key: turn.key,
      endTimeMs: endMs,
      ...(status !== undefined ? { status } : {}),
      ...(turn.sawUsage
        ? {
            tokenUsage: {
              inputTokens: turn.usage.input,
              outputTokens: turn.usage.output,
              cacheReadTokens: turn.usage.cacheRead,
            } satisfies TokenUsage,
          }
        : {}),
      ...(turn.lastAgentText !== undefined ? { outputSummary: toSummary(turn.lastAgentText) } : {}),
      ...(payloadRef !== undefined ? { payloadRef } : {}),
    };
    events.push(close);
    turn = undefined;
  }

  function turnEvent(name: string, startMs: number, text: string): void {
    if (turn === undefined) return;
    const event: SpanEvent = { name, timestampMs: startMs, attributes: { text: toSummary(text) } };
    events.push({ type: 'span.event', key: turn.key, event });
  }

  function applyUsage(usage: RolloutUsage): void {
    if (turn !== undefined) {
      turn.usage.input += usage.inputTokens;
      turn.usage.output += usage.outputTokens;
      turn.usage.cacheRead += usage.cachedInputTokens;
      turn.sawUsage = true;
    }
    if (llm !== undefined) llm.usage = usage;
  }

  function spawnAttrs(argsText: string): Record<string, SpanAttributeValue> {
    const attrs: Record<string, SpanAttributeValue> = { 'agent.spawn': true };
    const args = asRecord(safeJson(argsText));
    if (args !== undefined) {
      const agentType = asString(args['agent_type']);
      if (agentType !== undefined) attrs['agent.spawn.agentType'] = agentType;
      if (args['fork_context'] === true) attrs['agent.spawn.forkContext'] = true;
    }
    return attrs;
  }

  function openToolCall(
    rec: RolloutRecord,
    startMs: number,
    name: string,
    callId: string | undefined,
    argsText: string,
    summaryText: string,
  ): void {
    const segment = ensureLlm(rec, startMs);
    segment.lastMs = Math.max(segment.lastMs, startMs);
    const keySuffix = callId ?? `line${rec.lineNo}`;
    const key = `tool:${tid}:${keySuffix}`;
    const isSpawn = name === 'spawn_agent';
    const attributes: Record<string, SpanAttributeValue> = {
      ...baseAttributes(),
      ...(isSpawn ? spawnAttrs(argsText) : {}),
    };
    const payloadRef = store({ name, arguments: argsText });
    events.push({
      type: 'span.open',
      key,
      parentKey: segment.key,
      sourceRowKey: rowKey(rec),
      kind: 'TOOL_CALL',
      name: `tool:${name}`,
      startTimeMs: startMs,
      toolName: name,
      attributes,
      inputSummary: toSummary(summaryText),
      ...(payloadRef !== undefined ? { payloadRef } : {}),
    });
    if (callId === undefined) {
      // No call_id to pair against: close immediately (zero-duration).
      events.push({ type: 'span.close', key, endTimeMs: startMs });
      return;
    }
    const tool: OpenTool = { key, name, callId, argsText, startMs };
    if (isSpawn) {
      const spawn: SpawnCallInfo = { callId, toolKey: key, startMs, argsText };
      tool.spawn = spawn;
      result.spawnCalls.push(spawn);
    } else if (MULTI_AGENT_TOOLS.has(name)) {
      result.waitArgTexts.push(argsText);
    }
    openTools.set(callId, tool);
  }

  function closeToolCall(rec: RolloutRecord, endMs: number, output: unknown): void {
    const callId = asString(rec.payload['call_id']);
    if (callId === undefined) return;
    const tool = openTools.get(callId);
    if (tool === undefined) return;
    openTools.delete(callId);
    const { text, success } = functionOutputText(output);
    const attributes: Record<string, SpanAttributeValue> = {};
    if (tool.name === 'spawn_agent') {
      const parsed = asRecord(safeJson(text));
      const agentId = asString(parsed?.['agent_id']);
      const nickname = asString(parsed?.['nickname']);
      if (agentId !== undefined) attributes[ATTR.AGENT_SPAWN_CHILD_AGENT_ID] = agentId;
      if (nickname !== undefined) attributes['agent.spawn.nickname'] = nickname;
      if (tool.spawn !== undefined) {
        tool.spawn.endMs = endMs;
        tool.spawn.outputText = text;
      }
    }
    events.push({
      type: 'span.close',
      key: tool.key,
      endTimeMs: endMs,
      ...(success === false ? { status: { code: 'error' as const } } : {}),
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      ...(text !== '' ? { outputSummary: toSummary(text) } : {}),
    });
    // Tool output ends the model-request segment that produced the call.
    closeLlm(endMs);
  }

  for (const rec of records) {
    if (rec.lineNo < emitFromLine) continue;
    const startMs = touch(rec);

    if (rec.type === 'session_meta') {
      if (rec.lineNo === metaLineNo && sawSessionMeta) {
        const attributes: Record<string, SpanAttributeValue> = {};
        if (meta.cliVersion !== undefined) attributes['codex.cliVersion'] = meta.cliVersion;
        if (meta.modelProvider !== undefined) attributes['gen_ai.provider.name'] = meta.modelProvider;
        events.push({
          type: 'session.meta',
          ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
          ...(meta.startedAtMs !== undefined ? { startedAtMs: meta.startedAtMs } : {}),
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        });
      }
      openSession(meta.startedAtMs ?? startMs);
      continue;
    }
    openSession(startMs);

    if (rec.type === 'turn_context') {
      const model = asString(rec.payload['model']);
      if (model !== undefined) currentModel = model;
      continue;
    }

    if (rec.type === 'response_item') {
      const itemType = asString(rec.payload['type']);
      switch (itemType) {
        case 'message': {
          const role = asString(rec.payload['role']) ?? 'unknown';
          const text = contentText(rec.payload['content']);
          if (role === 'assistant') {
            ensureLlm(rec, startMs).lastMs = startMs;
            if (text !== '' && llm !== undefined) llm.outputText = text;
          } else {
            // User/developer input ends the current model-request segment.
            closeLlm(startMs);
            if (role === 'user' && text !== '') {
              if (turn !== undefined) turn.userTexts.push(text);
              turnEvent('gen_ai.user.message', startMs, text);
            }
          }
          break;
        }
        case 'reasoning': {
          const text = reasoningText(rec.payload['summary']);
          ensureLlm(rec, startMs, text !== '' ? text : undefined).lastMs = startMs;
          break;
        }
        case 'function_call':
        case 'custom_tool_call': {
          const rawName = asString(rec.payload['name']) ?? 'unknown';
          const name = normalizeToolName(rawName);
          const argsText =
            asString(rec.payload['arguments']) ?? asString(rec.payload['input']) ?? '';
          const callId = asString(rec.payload['call_id']);
          let summary = argsText;
          if (name === 'spawn_agent') {
            const args = asRecord(safeJson(argsText));
            const message = asString(args?.['message']);
            if (message !== undefined) summary = message;
          }
          openToolCall(rec, startMs, name, callId, argsText, summary);
          break;
        }
        case 'tool_search_call': {
          const callId = asString(rec.payload['call_id']);
          const argsText = JSON.stringify(rec.payload['arguments'] ?? null);
          openToolCall(rec, startMs, 'tool_search', callId, argsText, argsText);
          break;
        }
        case 'function_call_output':
        case 'custom_tool_call_output':
        case 'tool_search_output': {
          closeToolCall(rec, startMs, rec.payload['output']);
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (rec.type === 'event_msg') {
      const eventType = asString(rec.payload['type']);
      switch (eventType) {
        case 'task_started': {
          closeLlm(startMs);
          if (turn !== undefined) closeTurn(startMs, { code: 'error', message: 'missing task_complete' });
          const started = epochSecondsToMs(rec.payload['started_at']) ?? startMs;
          result.turnStarts.push(started);
          openTurn(rec, started);
          break;
        }
        case 'task_complete': {
          closeLlm(startMs);
          const lastAgent = asString(rec.payload['last_agent_message']);
          if (lastAgent !== undefined && turn !== undefined) turn.lastAgentText = lastAgent;
          closeTurn(startMs);
          break;
        }
        case 'turn_aborted': {
          closeLlm(startMs);
          const reason = asString(rec.payload['reason']) ?? 'aborted';
          closeTurn(startMs, { code: 'error', message: `turn_aborted: ${reason}` });
          break;
        }
        case 'token_count': {
          const usage = extractLastUsage(rec.payload);
          if (usage !== undefined) applyUsage(usage);
          // A token_count marks the end of one model request.
          closeLlm(startMs);
          break;
        }
        case 'user_message': {
          closeLlm(startMs);
          const text = asString(rec.payload['message']);
          if (text !== undefined && text !== '') {
            if (turn !== undefined) turn.userTexts.push(text);
            turnEvent('gen_ai.user.message', startMs, text);
          }
          break;
        }
        case 'agent_message': {
          const text = asString(rec.payload['message']);
          if (text !== undefined && text !== '') {
            if (turn !== undefined) turn.lastAgentText = text;
            turnEvent('gen_ai.agent.message', startMs, text);
          }
          break;
        }
        case 'collab_agent_spawn_end': {
          const callId = asString(rec.payload['call_id']);
          const end: CollabSpawnEnd = { callId: callId ?? '' };
          const newThreadId = asString(rec.payload['new_thread_id']);
          const nickname = asString(rec.payload['new_agent_nickname']);
          if (newThreadId !== undefined) end.newThreadId = newThreadId;
          if (nickname !== undefined) end.newAgentNickname = nickname;
          result.collabSpawnEnds.push(end);
          if (callId !== undefined) {
            const tool = openTools.get(callId);
            if (tool !== undefined && newThreadId !== undefined) {
              const attributes: Record<string, SpanAttributeValue> = {
                [ATTR.AGENT_SPAWN_CHILD_AGENT_ID]: newThreadId,
              };
              if (nickname !== undefined) attributes['agent.spawn.nickname'] = nickname;
              events.push({ type: 'span.attr', key: tool.key, attributes });
            }
          }
          break;
        }
        default:
          break;
      }
      continue;
    }
  }

  // End of file: the LLM segment is adapter-synthesized, so close it
  // explicitly (approx). SESSION / AGENT_TURN / TOOL_CALL spans are left open
  // on purpose — the pipeline closes them via closeAllIncomplete.
  const eofMs = result.lastActivityMs ?? meta.startedAtMs ?? 0;
  closeLlm(eofMs);

  return result;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
