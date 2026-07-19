/**
 * Span tree utilities — ported from agent-flow/apps/trace-ui/lib/tree.ts
 * (same author). Only the two helpers the UI needs are kept.
 *
 * Boundary handling:
 *   - parentSpanId pointing to a non-existent span: that span is treated as
 *     a root by the caller (SpanTree) so it still renders.
 *   - traceWindow reads ALL spans, robust to a missing/over-long root.
 */
import type { Span } from './types.js';

/** Direct children of a span, sorted by startTimeMs. */
export function childrenOf(spanId: string, spans: Span[]): Span[] {
  return spans
    .filter((s) => s.parentSpanId === spanId)
    .sort((a, b) => a.startTimeMs - b.startTimeMs);
}

/**
 * Compute the session's overall [start, end] window across ALL spans.
 * duration is clamped to >= 1 so relative-width bars never divide by zero.
 */
export function traceWindow(spans: Span[]): {
  start: number;
  end: number;
  duration: number;
} {
  if (spans.length === 0) return { start: 0, end: 0, duration: 1 };
  let start = Infinity;
  let end = -Infinity;
  for (const s of spans) {
    if (s.startTimeMs < start) start = s.startTimeMs;
    const e = s.startTimeMs + s.durationMs;
    if (e > end) end = e;
  }
  const duration = Math.max(end - start, 1);
  return { start, end, duration };
}
