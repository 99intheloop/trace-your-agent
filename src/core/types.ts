/**
 * Core span model for trace-your-agent.
 *
 * Flat, OTel GenAI semantic-convention-aligned structure. Every agent source
 * (Claude Code, Codex, Kimi Code) is normalized into this model by adapters,
 * and everything downstream (store, server, UI) depends only on this file.
 */

export type SpanKind = 'SESSION' | 'AGENT_TURN' | 'LLM_CALL' | 'TOOL_CALL';

export interface SpanStatus {
  code: 'ok' | 'error';
  message?: string;
}

export type SpanAttributeValue = string | number | boolean;

export interface SpanEvent {
  name: string;
  timestampMs: number;
  attributes?: Record<string, SpanAttributeValue>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface Span {
  /** 32 hex chars. Diagnostic identity of one recorded session (one trace = one ingested session file). */
  traceId: string;
  /** 16 hex chars. Deterministic per source row — see ids.ts. */
  spanId: string;
  parentSpanId?: string;
  kind: SpanKind;
  name: string;
  startTimeMs: number;
  durationMs: number;
  status: SpanStatus;
  /**
   * Flat attributes using semconv-style dotted names: `gen_ai.*`, `session.id`,
   * `agent.*`, ... See {@link ATTR} for the keys this project relies on.
   */
  attributes: Record<string, SpanAttributeValue>;
  events?: SpanEvent[];
  tokenUsage?: TokenUsage;
  toolName?: string;
  /** <= 500 chars. Full input, when retained, goes to the payload store. */
  inputSummary?: string;
  outputSummary?: string;
  agentName?: string;
  /** Content-addressed reference into the payload store: `payloads/<sha256>.json`. */
  payloadRef?: string;
}

export interface Link {
  fromSpanId: string;
  toSpanId: string;
  kind: 'NOTIFY' | 'MESSAGE';
}

/** Supported agent sources. */
export type Source = 'claude-code' | 'codex' | 'kimi-code';

/**
 * How confidently a span was attached to its parent:
 * - `structural`: explicit parent id in the source format.
 * - `semi`: derived from strong structure (e.g. nesting, tool_use id pairing).
 * - `heuristic`: guessed from timing/order — may be wrong.
 */
export type JoinQuality = 'structural' | 'semi' | 'heuristic';

/**
 * Well-known attribute keys.
 *
 * Identity model: `traceId` is the *diagnostic* identity (one ingested session
 * file), while `session.id` is the *product* identity used for aggregation.
 * They are deliberately separate: re-ingesting a session keeps `session.id`
 * stable even if trace-level bookkeeping changes.
 */
export const ATTR = {
  /** Product identity of a session; used for grouping/aggregation. */
  SESSION_ID: 'session.id',
  /** Producing agent: 'claude-code' | 'codex' | 'kimi-code'. */
  SOURCE: 'source',
  /** Stable id of the agent (main agent or subagent) that produced the span. */
  AGENT_ID: 'agent.id',
  /** Id of the parent agent that spawned {@link ATTR.AGENT_ID}. */
  AGENT_PARENT_ID: 'agent.parent.id',
  /** Set on a spawn event/span: id of the child agent being started. */
  AGENT_SPAWN_CHILD_AGENT_ID: 'agent.spawn.childAgentId',
  /** {@link JoinQuality} of the parent attachment for this span. */
  JOIN_QUALITY: 'joinQuality',
  /** `true` marks a background/detached subagent span tree. */
  DETACHED: 'detached',
  /** `true` when durationMs was inferred rather than measured. */
  APPROX: 'approx',
  /** `true` when the span was closed by end-of-file cleanup, not by a real end event. */
  INCOMPLETE: 'incomplete',
  /** Model name used for an LLM call (OTel GenAI semconv key). */
  GEN_AI_MODEL: 'gen_ai.request.model',
} as const;

export const MAX_SUMMARY_CHARS = 500;

/** Truncate a summary string to the contract limit. */
export function toSummary(text: string, maxChars: number = MAX_SUMMARY_CHARS): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}
