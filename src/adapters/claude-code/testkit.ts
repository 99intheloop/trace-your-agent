/**
 * Test harness: replays an adapter's RawEvent stream through SpanBuilder the
 * way the (later) ingest pipeline is specified to in core/source.ts:
 * spanId = spanIdFor(traceId, sourceRowKey), parentKey resolved only while the
 * parent is open, leftover spans closed via closeAllIncomplete.
 */
import { spanIdFor } from '../../core/ids.js';
import type { RawEvent, RawSessionMetaEvent } from '../../core/source.js';
import { SpanBuilder } from '../../core/span-builder.js';
import type { Link, Span } from '../../core/types.js';

export interface HarnessResult {
  spans: Span[];
  links: Link[];
  meta?: RawSessionMetaEvent;
}

export async function collectSpans(traceId: string, events: AsyncIterable<RawEvent>): Promise<HarnessResult> {
  const builder = new SpanBuilder();
  const keyToSpanId = new Map<string, string>();
  const links: Link[] = [];
  let meta: RawSessionMetaEvent | undefined;
  let lastTs = 0;

  for await (const ev of events) {
    switch (ev.type) {
      case 'session.meta': {
        meta = ev;
        break;
      }
      case 'span.open': {
        const spanId = spanIdFor(traceId, ev.sourceRowKey);
        keyToSpanId.set(ev.key, spanId);
        if (builder.isOpen(ev.key)) break; // at-least-once re-emission
        const parentSpanId =
          ev.parentKey !== undefined && builder.isOpen(ev.parentKey) ? keyToSpanId.get(ev.parentKey) : undefined;
        builder.openSpan(ev.key, {
          traceId,
          spanId,
          kind: ev.kind,
          name: ev.name,
          startTimeMs: ev.startTimeMs,
          ...(parentSpanId !== undefined ? { parentSpanId } : {}),
          ...(ev.status !== undefined ? { status: ev.status } : {}),
          ...(ev.attributes !== undefined ? { attributes: ev.attributes } : {}),
          ...(ev.events !== undefined ? { events: ev.events } : {}),
          ...(ev.toolName !== undefined ? { toolName: ev.toolName } : {}),
          ...(ev.agentName !== undefined ? { agentName: ev.agentName } : {}),
          ...(ev.inputSummary !== undefined ? { inputSummary: ev.inputSummary } : {}),
          ...(ev.payloadRef !== undefined ? { payloadRef: ev.payloadRef } : {}),
        });
        lastTs = Math.max(lastTs, ev.startTimeMs);
        break;
      }
      case 'span.attr': {
        builder.updateSpan(ev.key, { attributes: ev.attributes });
        break;
      }
      case 'span.event': {
        builder.updateSpan(ev.key, { events: [ev.event] });
        lastTs = Math.max(lastTs, ev.event.timestampMs);
        break;
      }
      case 'span.close': {
        builder.closeSpan(ev.key, {
          endTimeMs: ev.endTimeMs,
          ...(ev.status !== undefined ? { status: ev.status } : {}),
          ...(ev.attributes !== undefined ? { attributes: ev.attributes } : {}),
          ...(ev.tokenUsage !== undefined ? { tokenUsage: ev.tokenUsage } : {}),
          ...(ev.outputSummary !== undefined ? { outputSummary: ev.outputSummary } : {}),
          ...(ev.payloadRef !== undefined ? { payloadRef: ev.payloadRef } : {}),
        });
        lastTs = Math.max(lastTs, ev.endTimeMs);
        break;
      }
      case 'link': {
        const fromSpanId = keyToSpanId.get(ev.fromKey);
        const toSpanId = keyToSpanId.get(ev.toKey);
        if (fromSpanId !== undefined && toSpanId !== undefined) {
          links.push({ fromSpanId, toSpanId, kind: ev.kind });
        }
        break;
      }
    }
  }
  builder.closeAllIncomplete(lastTs);
  const result: HarnessResult = { spans: [...builder.spans], links };
  if (meta !== undefined) result.meta = meta;
  return result;
}

/** Compact, stable view of a span tree for assertions/snapshots. */
export function treeView(spans: readonly Span[]): Array<Record<string, unknown>> {
  return [...spans]
    .sort((a, b) => (a.startTimeMs !== b.startTimeMs ? a.startTimeMs - b.startTimeMs : a.spanId.localeCompare(b.spanId)))
    .map((s) => {
      const out: Record<string, unknown> = {
        spanId: s.spanId,
        parentSpanId: s.parentSpanId ?? null,
        kind: s.kind,
        name: s.name,
        startTimeMs: s.startTimeMs,
        durationMs: s.durationMs,
        status: s.status.code,
        attributes: s.attributes,
      };
      if (s.toolName !== undefined) out['toolName'] = s.toolName;
      if (s.tokenUsage !== undefined) out['tokenUsage'] = s.tokenUsage;
      if (s.inputSummary !== undefined) out['inputSummary'] = s.inputSummary;
      if (s.outputSummary !== undefined) out['outputSummary'] = s.outputSummary;
      if (s.agentName !== undefined) out['agentName'] = s.agentName;
      if (s.events !== undefined) out['events'] = s.events;
      if (s.payloadRef !== undefined) out['payloadRef'] = 'payloads/<sha256>.json';
      return out;
    });
}
