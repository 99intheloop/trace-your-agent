/**
 * Codex rollout wire format (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
 *
 * Each line is `{ timestamp: ISO string, type, payload }` with
 * `type ∈ session_meta | turn_context | response_item | event_msg`
 * (serde: `RolloutItem`, tag="type", content="payload" —
 * codex-rs/protocol/src/protocol.rs:2981).
 *
 * All helpers here are pure and defensive: unknown/malformed rows are
 * tolerated, never thrown on, because we parse other people's log files.
 */

/** One parsed rollout line. `payload` is the raw object, unvalidated. */
export interface RolloutRecord {
  /** Line number within its file (0-based). Used for sourceRowKey. */
  lineNo: number;
  /** Parsed `timestamp` (ms since epoch), undefined when missing/invalid. */
  timestampMs?: number;
  type: string;
  payload: Record<string, unknown>;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Parse one JSONL line. Returns undefined for blank/malformed lines. */
export function parseRolloutLine(lineNo: number, text: string): RolloutRecord | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const type = asString(record['type']);
  const payload = asRecord(record['payload']);
  if (type === undefined || payload === undefined) return undefined;
  const result: RolloutRecord = { lineNo, type, payload };
  const ts = asString(record['timestamp']);
  if (ts !== undefined) {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) result.timestampMs = ms;
  }
  return result;
}

/**
 * Normalized identity of one thread, extracted from the `session_meta` payload
 * (serde: `SessionMetaLine` = flattened `SessionMeta` + `git` —
 * protocol.rs:2906/2972; `SessionSource` protocol.rs:2617,
 * `SubAgentSource::ThreadSpawn` protocol.rs:2698).
 *
 * On the wire `source` is either a plain string ("cli", "vscode", ...) or
 * `{"subagent": {"thread_spawn": {parent_thread_id, depth, agent_path,
 * agent_nickname, agent_role}}}` — confirmed against real rollout files.
 */
export interface CodexThreadMeta {
  threadId: string;
  /** Direct parent thread (sub-agent spawn). From `parent_thread_id` or `source.subagent.thread_spawn`. */
  parentThreadId?: string;
  /** Thread this one was forked from (`forked_from_id`). */
  forkedFromId?: string;
  agentNickname?: string;
  agentRole?: string;
  /** Spawn depth for sub-agent threads. */
  depth?: number;
  cwd?: string;
  startedAtMs?: number;
  cliVersion?: string;
  modelProvider?: string;
  originator?: string;
  /** Human-readable source classification, e.g. "cli" or "subagent_thread_spawn". */
  sourceKind?: string;
  multiAgentVersion?: string;
}

/** Extract thread identity from a `session_meta` payload. Undefined when no `id`. */
export function extractThreadMeta(payload: Record<string, unknown>): CodexThreadMeta | undefined {
  const threadId = asString(payload['id']);
  if (threadId === undefined) return undefined;
  const meta: CodexThreadMeta = { threadId };

  const parentDirect = asString(payload['parent_thread_id']);
  const forkedFrom = asString(payload['forked_from_id']);
  if (forkedFrom !== undefined) meta.forkedFromId = forkedFrom;

  const source = payload['source'];
  let sourceKind: string | undefined;
  if (typeof source === 'string') {
    sourceKind = source;
  } else {
    const sourceObj = asRecord(source);
    const subagent = asRecord(sourceObj?.['subagent']);
    const threadSpawn = asRecord(subagent?.['thread_spawn']);
    if (threadSpawn !== undefined) {
      sourceKind = 'subagent_thread_spawn';
      const spawnParent = asString(threadSpawn['parent_thread_id']);
      if (parentDirect === undefined && spawnParent !== undefined) {
        meta.parentThreadId = spawnParent;
      }
      const depth = threadSpawn['depth'];
      if (typeof depth === 'number') meta.depth = depth;
      const nickname = asString(threadSpawn['agent_nickname']);
      if (nickname !== undefined) meta.agentNickname = nickname;
      const role = asString(threadSpawn['agent_role']) ?? asString(threadSpawn['agent_type']);
      if (role !== undefined) meta.agentRole = role;
    }
  }
  if (parentDirect !== undefined) meta.parentThreadId = parentDirect;

  // Top-level agent_nickname / agent_role exist independently of `source`.
  const nick = asString(payload['agent_nickname']);
  if (nick !== undefined) meta.agentNickname = nick;
  const role = asString(payload['agent_role']) ?? asString(payload['agent_type']);
  if (role !== undefined) meta.agentRole = role;

  const cwd = asString(payload['cwd']);
  if (cwd !== undefined) meta.cwd = cwd;
  const ts = asString(payload['timestamp']);
  if (ts !== undefined) {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) meta.startedAtMs = ms;
  }
  const cli = asString(payload['cli_version']);
  if (cli !== undefined) meta.cliVersion = cli;
  const mp = asString(payload['model_provider']);
  if (mp !== undefined) meta.modelProvider = mp;
  const orig = asString(payload['originator']);
  if (orig !== undefined) meta.originator = orig;
  const mav = asString(payload['multi_agent_version']);
  if (mav !== undefined) meta.multiAgentVersion = mav;

  if (sourceKind !== undefined) meta.sourceKind = sourceKind;
  else if (meta.parentThreadId !== undefined) meta.sourceKind = 'subagent';
  return meta;
}

/** Extract the rollout-file uuid from a `rollout-<ts>-<uuid>.jsonl` basename. */
export function threadIdFromFilename(basename: string): string | undefined {
  const match = /^rollout-.+-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(
    basename,
  );
  return match?.[1]?.toLowerCase();
}

/** v1/v2 multi-agent tool names (codex-rs core/src/tools/handlers/multi_agents, multi_agents_v2). */
export const MULTI_AGENT_TOOLS = new Set([
  'spawn_agent',
  'send_input',
  'send_message',
  'wait_agent',
  'resume_agent',
  'close_agent',
  'interrupt_agent',
]);

/**
 * Normalize a function_call name: newer CLI may emit namespaced forms
 * (`multi_agent_v1.spawn_agent`, `ns/name`); older files use a separate
 * `namespace` field and a plain `name`.
 */
export function normalizeToolName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot >= 0 && dot < name.length - 1) return name.slice(dot + 1);
  const slash = name.lastIndexOf('/');
  if (slash >= 0 && slash < name.length - 1) return name.slice(slash + 1);
  return name;
}

/** Flatten a message/reasoning content array into plain text. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    if (rec === undefined) continue;
    const text = asString(rec['text']);
    if (text !== undefined) parts.push(text);
  }
  return parts.join('\n');
}

/** Reasoning summary: array of `{type: 'summary_text', text}` — models.rs:947. */
export function reasoningText(summary: unknown): string {
  return contentText(summary);
}

/**
 * `function_call_output.output` is a `FunctionCallOutputPayload`: on the wire
 * either a plain string or `{content | content_items, success?}`
 * (models.rs:1010). Returns text + explicit success flag when present.
 */
export function functionOutputText(output: unknown): { text: string; success?: boolean } {
  if (typeof output === 'string') return { text: output };
  const rec = asRecord(output);
  if (rec === undefined) return { text: '' };
  const text =
    asString(rec['content']) ??
    (Array.isArray(rec['content_items']) ? contentText(rec['content_items']) : '');
  const success = rec['success'];
  const result: { text: string; success?: boolean } = { text };
  if (typeof success === 'boolean') result.success = success;
  return result;
}

/** `token_count` payload → per-request usage (`info.last_token_usage`, protocol.rs:2014/2081). */
export interface RolloutUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export function extractLastUsage(payload: Record<string, unknown>): RolloutUsage | undefined {
  const info = asRecord(payload['info']);
  const last = asRecord(info?.['last_token_usage']);
  if (last === undefined) return undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(last['input_tokens']),
    cachedInputTokens: num(last['cached_input_tokens']),
    outputTokens: num(last['output_tokens']),
    reasoningOutputTokens: num(last['reasoning_output_tokens']),
    totalTokens: num(last['total_tokens']),
  };
}

/** Seconds-or-ms timestamp fields (`task_started.started_at` is seconds; collab events use *_ms). */
export function epochSecondsToMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(value * 1000);
}
