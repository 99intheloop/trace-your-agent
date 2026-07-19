/**
 * UI-side types, aligned with docs/api.md (the frozen server↔UI contract).
 *
 * Span / Link / attribute keys come straight from src/core/types.ts — the
 * same source of truth the server serializes from. SessionSummary / SearchHit
 * exist only in the API contract, so they are declared here verbatim.
 *
 * The attribute accessor helpers are ported from
 * agent-flow/apps/trace-ui/lib/types.ts (same author).
 */
import { ATTR } from '../../core/types.js';
import type { Link, Span, SpanAttributeValue } from '../../core/types.js';

export { ATTR };
export type {
  JoinQuality,
  Link,
  Span,
  SpanAttributeValue,
  SpanEvent,
  SpanKind,
  SpanStatus,
  TokenUsage,
} from '../../core/types.js';

/** GET /api/sessions item & GET /api/sessions/:id (docs/api.md). */
export interface SessionSummary {
  sessionId: string;
  source: string;
  cwd?: string;
  startedAtMs?: number;
  spanCount: number;
  agentCount: number;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  errorCount: number;
  joinQualityStats: Record<string, number>;
  /** spanQ 过滤时:该 session 的 FTS 命中 span 数。 */
  spanHits?: number;
}

/** GET /api/search hit (docs/api.md). */
export interface SearchHit {
  spanId: string;
  sessionId: string;
  kind: string;
  name: string;
  toolName?: string;
  snippet: string;
  /** 首个命中的字段(in/out/name 徽章)。 */
  matchedField?: 'input' | 'output' | 'name';
  /** 所属 session 的 cwd(展示项目名)。 */
  cwd?: string;
  /** 平台徽章(claude-code/codex/kimi-code)。 */
  source?: string;
  startTimeMs: number;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
  total: number;
}

export interface SpansResponse {
  spans: Span[];
  links: Link[];
}

export interface SearchResponse {
  results: SearchHit[];
}

export interface SourcesResponse {
  sources: Array<{ source: string; count: number }>;
  total: number;
}

export interface CwdsResponse {
  cwds: Array<{ cwd: string; count: number }>;
}

// ─── Type-safe attribute accessors (ported from trace-ui/lib/types.ts) ─────

/** Read a string attribute; returns undefined for missing/non-string values. */
export function attrString(span: Span, key: string): string | undefined {
  const v = span.attributes[key];
  return typeof v === 'string' ? v : undefined;
}

/** Read a number attribute; returns undefined for missing/non-number values. */
export function attrNumber(span: Span, key: string): number | undefined {
  const v = span.attributes[key];
  return typeof v === 'number' ? v : undefined;
}

/** Read a boolean attribute; returns undefined for missing/non-boolean values. */
export function attrBool(span: Span, key: string): boolean | undefined {
  const v = span.attributes[key];
  return typeof v === 'boolean' ? v : undefined;
}

/** True for spans attached to their parent by timing/order guesswork. */
export function isHeuristicJoin(span: Span): boolean {
  return attrString(span, ATTR.JOIN_QUALITY) === 'heuristic';
}

/** True for background/detached subagent span trees. */
export function isDetached(span: Span): boolean {
  return attrBool(span, ATTR.DETACHED) === true;
}

/** True when the span was closed by end-of-file cleanup, not a real end event. */
export function isIncomplete(span: Span): boolean {
  return attrBool(span, ATTR.INCOMPLETE) === true;
}

/** True when durationMs was inferred rather than measured. */
export function isApprox(span: Span): boolean {
  return attrBool(span, ATTR.APPROX) === true;
}

/** True if the span is a TOOL_CALL that spawned a child agent. */
export function isSpawnSpan(span: Span): boolean {
  return (
    span.kind === 'TOOL_CALL' &&
    attrString(span, ATTR.AGENT_SPAWN_CHILD_AGENT_ID) !== undefined
  );
}
