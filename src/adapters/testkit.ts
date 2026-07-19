import { spanIdFor } from '../core/ids.js';
import type { RawEvent, RawSessionMetaEvent } from '../core/source.js';
import { SpanBuilder } from '../core/span-builder.js';
import type { Link, Span } from '../core/types.js';

/**
 * Minimal RawEvent → Span harness for adapter tests. Mirrors the documented
 * ingest-pipeline semantics (source.ts): spanId from sourceRowKey, parentKey
 * resolved among currently-open spans, unclosed spans finished via
 * closeAllIncomplete, links resolved against every previously-opened key.
 * (The real pipeline lands in a later milestone; tests must not depend on it.)
 */
export interface HarnessResult {
  spans: Span[];
  links: Link[];
  sessionMeta: RawSessionMetaEvent[];
}

export function runEvents(events: Iterable<RawEvent>, traceId: string): HarnessResult {
  const builder = new SpanBuilder();
  const openKeys = new Map<string, string>();
  const seenKeys = new Map<string, string>();
  const links: Link[] = [];
  const sessionMeta: RawSessionMetaEvent[] = [];
  let lastSeenMs = 0;

  for (const event of events) {
    switch (event.type) {
      case 'session.meta': {
        sessionMeta.push(event);
        if (event.startedAtMs !== undefined) lastSeenMs = Math.max(lastSeenMs, event.startedAtMs);
        break;
      }
      case 'span.open': {
        const spanId = spanIdFor(traceId, event.sourceRowKey);
        const parentSpanId =
          event.parentKey !== undefined ? openKeys.get(event.parentKey) : undefined;
        builder.openSpan(event.key, {
          traceId,
          spanId,
          ...(parentSpanId !== undefined ? { parentSpanId } : {}),
          kind: event.kind,
          name: event.name,
          startTimeMs: event.startTimeMs,
          ...(event.status !== undefined ? { status: event.status } : {}),
          ...(event.attributes !== undefined ? { attributes: event.attributes } : {}),
          ...(event.events !== undefined ? { events: event.events } : {}),
          ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
          ...(event.agentName !== undefined ? { agentName: event.agentName } : {}),
          ...(event.inputSummary !== undefined ? { inputSummary: event.inputSummary } : {}),
          ...(event.payloadRef !== undefined ? { payloadRef: event.payloadRef } : {}),
        });
        openKeys.set(event.key, spanId);
        seenKeys.set(event.key, spanId);
        lastSeenMs = Math.max(lastSeenMs, event.startTimeMs);
        break;
      }
      case 'span.attr': {
        builder.updateSpan(event.key, { attributes: event.attributes });
        break;
      }
      case 'span.event': {
        builder.updateSpan(event.key, { events: [event.event] });
        lastSeenMs = Math.max(lastSeenMs, event.event.timestampMs);
        break;
      }
      case 'span.close': {
        builder.closeSpan(event.key, {
          endTimeMs: event.endTimeMs,
          ...(event.status !== undefined ? { status: event.status } : {}),
          ...(event.attributes !== undefined ? { attributes: event.attributes } : {}),
          ...(event.events !== undefined ? { events: event.events } : {}),
          ...(event.tokenUsage !== undefined ? { tokenUsage: event.tokenUsage } : {}),
          ...(event.outputSummary !== undefined ? { outputSummary: event.outputSummary } : {}),
          ...(event.payloadRef !== undefined ? { payloadRef: event.payloadRef } : {}),
        });
        openKeys.delete(event.key);
        lastSeenMs = Math.max(lastSeenMs, event.endTimeMs);
        break;
      }
      case 'link': {
        const fromSpanId = seenKeys.get(event.fromKey);
        const toSpanId = seenKeys.get(event.toKey);
        if (fromSpanId !== undefined && toSpanId !== undefined) {
          links.push({ fromSpanId, toSpanId, kind: event.kind });
        }
        break;
      }
    }
  }
  builder.closeAllIncomplete(lastSeenMs);
  return { spans: [...builder.spans], links, sessionMeta };
}

/** Compact, deterministic view of a span forest for assertions/snapshots. */
export interface SpanNode {
  kind: string;
  name: string;
  toolName?: string;
  status: string;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
  tokenUsage?: unknown;
  inputSummary?: string;
  outputSummary?: string;
  children: SpanNode[];
}

export function spanForest(spans: readonly Span[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>();
  for (const span of spans) {
    nodes.set(span.spanId, {
      kind: span.kind,
      name: span.name,
      ...(span.toolName !== undefined ? { toolName: span.toolName } : {}),
      status: span.status.message !== undefined ? `${span.status.code}:${span.status.message}` : span.status.code,
      durationMs: span.durationMs,
      attributes: span.attributes,
      ...(span.tokenUsage !== undefined ? { tokenUsage: span.tokenUsage } : {}),
      ...(span.inputSummary !== undefined ? { inputSummary: span.inputSummary } : {}),
      ...(span.outputSummary !== undefined ? { outputSummary: span.outputSummary } : {}),
      children: [],
    });
  }
  const roots: SpanNode[] = [];
  for (const span of spans) {
    const node = nodes.get(span.spanId);
    if (node === undefined) continue;
    const parent = span.parentSpanId !== undefined ? nodes.get(span.parentSpanId) : undefined;
    if (parent !== undefined) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function findSpan(spans: readonly Span[], kind: Span['kind'], toolName?: string): Span {
  const found = spans.find(
    (s) => s.kind === kind && (toolName === undefined || s.toolName === toolName),
  );
  if (found === undefined) {
    throw new Error(`span not found: ${kind}${toolName !== undefined ? ` ${toolName}` : ''}`);
  }
  return found;
}
