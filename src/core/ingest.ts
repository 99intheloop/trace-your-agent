import { EventEmitter } from 'node:events';
import type { TraceStore } from '../store/store.js';
import { spanIdFor, traceIdFor } from './ids.js';
import type { OffsetStore } from './offsets.js';
import type { PayloadStore } from './payload-store.js';
import { redactString, type RedactOptions } from './redact.js';
import type { Adapter, DetectedHome, RawEvent, SessionRef } from './source.js';
import { SpanBuilder } from './span-builder.js';
import { ATTR, type Link, type Span, type SpanAttributeValue } from './types.js';

/**
 * Core ingest pipeline.
 *
 * Consumes the `AsyncIterable<RawEvent>` produced by an adapter's `parse()`,
 * drives a {@link SpanBuilder}, and persists completed spans/links into the
 * {@link TraceStore}. Per session file, on success, the {@link OffsetStore}
 * cursor is advanced so the next run resumes where this one stopped.
 *
 * Guarantees:
 * - **Idempotent**: span ids are deterministic (`spanIdFor(traceId, sourceRowKey)`)
 *   and the store upserts by span id, so re-ingesting the same offset range
 *   never duplicates spans.
 * - **Fault tolerant**: a single malformed RawEvent counts a warning and is
 *   skipped; a mid-file stream failure counts an error and skips the offset
 *   write (so the file is retried next run), while spans completed before the
 *   failure stay persisted (harmless — idempotent ids).
 * - **Realtime-ready**: every span written to the store is also emitted as a
 *   `'span'` event on {@link IngestPipeline.events}. Nothing subscribes today;
 *   a future WebSocket layer will.
 *
 * Payloads: the RawEvent contract carries `payloadRef`s (already content
 * addressed by the producing adapter via {@link PayloadStore.put}, which
 * redacts by default). The pipeline passes refs through unchanged and
 * additionally redacts free-form summaries (`inputSummary`/`outputSummary`)
 * before persistence — defense in depth, on by default.
 */

export interface IngestDeps {
  store: TraceStore;
  offsets: OffsetStore;
  /**
   * Shared payload store. The pipeline itself does not write payloads (refs
   * arrive ready-made in RawEvents); it is held here so adapters driven by
   * this pipeline can be handed the same store by callers.
   */
  payloads?: PayloadStore;
  /** Redaction applied to span summaries. Default: on. */
  redact?: RedactOptions;
}

export interface IngestReport {
  filesProcessed: number;
  spansWritten: number;
  linksWritten: number;
  warnings: number;
  errors: number;
}

/** Spans are flushed to the store in batches of this size. */
const FLUSH_BATCH_SIZE = 200;

export function emptyIngestReport(): IngestReport {
  return { filesProcessed: 0, spansWritten: 0, linksWritten: 0, warnings: 0, errors: 0 };
}

export class IngestPipeline {
  /** Emits `'span'` (payload: {@link Span}) for every span persisted. */
  readonly events = new EventEmitter();

  private readonly store: TraceStore;
  private readonly offsets: OffsetStore;
  private readonly redact: RedactOptions;

  constructor(deps: IngestDeps) {
    this.store = deps.store;
    this.offsets = deps.offsets;
    this.redact = deps.redact ?? {};
  }

  /**
   * Ingest every session file an adapter discovers under `home`
   * (detected via `adapter.detect()` when omitted).
   */
  async ingestAdapter(adapter: Adapter, home?: DetectedHome | null): Promise<IngestReport> {
    const report = emptyIngestReport();
    const resolvedHome = home === undefined ? await adapter.detect() : home;
    if (resolvedHome === null || resolvedHome === undefined) return report;

    for await (const ref of adapter.discover(resolvedHome)) {
      const cursor = this.offsets.get(ref.filePath);
      if (cursor !== undefined && !IngestPipeline.needsReparse(cursor, ref)) continue;
      // Resume where the cursor stopped; re-parse from 0 when the file
      // shrank (truncation/rotation). Deterministic span ids make re-emitted
      // rows harmless either way.
      const fromOffset =
        cursor !== undefined && cursor.size <= ref.size ? cursor.offset : 0;
      try {
        await this.ingestSession(adapter, ref, fromOffset, report);
        this.offsets.set(ref.filePath, {
          offset: ref.size,
          mtime: ref.mtime,
          size: ref.size,
        });
        report.filesProcessed += 1;
      } catch {
        // Mid-file failure: keep whatever spans were already written, but do
        // NOT advance the cursor — the file is retried on the next run.
        report.errors += 1;
      }
    }
    return report;
  }

  /**
   * Ingest one session file starting at byte `fromOffset`. Throws if the
   * event stream fails mid-file (per-event failures only count warnings).
   */
  async ingestSession(
    adapter: Adapter,
    ref: SessionRef,
    fromOffset: number,
    report: IngestReport = emptyIngestReport(),
  ): Promise<IngestReport> {
    const session = new SessionIngest(this, ref, report);
    try {
      for await (const event of adapter.parse(ref, fromOffset)) {
        try {
          session.handle(event);
        } catch {
          // A single malformed event must not abort the session.
          report.warnings += 1;
        }
      }
    } finally {
      // On a clean finish this closes spans still open as incomplete; on a
      // stream failure it still persists whatever completed, then the error
      // propagates and the caller skips the offset write.
      session.finish();
    }
    return report;
  }

  /** True when the recorded cursor says the file has no new bytes. */
  private static needsReparse(
    cursor: { offset: number; mtime: number; size: number },
    ref: SessionRef,
  ): boolean {
    return !(cursor.offset === ref.size && cursor.size === ref.size && cursor.mtime === ref.mtime);
  }

  /** @internal Persist a batch of spans and notify subscribers. */
  _writeSpans(spans: readonly Span[], report: IngestReport): void {
    if (spans.length === 0) return;
    this.store.insertSpans(spans);
    report.spansWritten += spans.length;
    for (const span of spans) this.events.emit('span', span);
  }

  /** @internal */
  _writeLinks(links: readonly Link[], report: IngestReport): void {
    if (links.length === 0) return;
    this.store.insertLinks(links);
    report.linksWritten += links.length;
  }

  /** @internal */
  _upsertSessionMeta(ref: SessionRef, meta: { cwd?: string; startedAtMs?: number }): void {
    this.store.upsertSessionMeta(ref.sessionId, ref.source, meta);
  }

  /** @internal */
  _redactSummary(text: string): string {
    return redactString(text, this.redact);
  }
}

/**
 * Per-session-file ingest state: the SpanBuilder, the key→spanId resolution
 * map (kept after close so `link` events can resolve endpoints), and the
 * pending write batches.
 */
class SessionIngest {
  private readonly builder = new SpanBuilder();
  private readonly keyToSpanId = new Map<string, string>();
  private readonly traceId: string;
  private lastSeenTimeMs = 0;
  private pendingSpans: Span[] = [];
  private pendingLinks: Link[] = [];

  constructor(
    private readonly pipeline: IngestPipeline,
    private readonly ref: SessionRef,
    private readonly report: IngestReport,
  ) {
    this.traceId = traceIdFor(ref.source, ref.sessionId);
    this.builder.onSpan((span) => {
      this.pendingSpans.push(span);
      if (this.pendingSpans.length >= FLUSH_BATCH_SIZE) this.flushSpans();
    });
  }

  handle(event: RawEvent): void {
    switch (event.type) {
      case 'session.meta':
        this.onSessionMeta(event);
        break;
      case 'span.open':
        this.onSpanOpen(event);
        break;
      case 'span.attr':
        this.onSpanAttr(event);
        break;
      case 'span.event':
        this.onSpanEvent(event);
        break;
      case 'span.close':
        this.onSpanClose(event);
        break;
      case 'link':
        this.onLink(event);
        break;
    }
  }

  /** EOF cleanup: close leftover spans as incomplete and flush everything. */
  finish(): void {
    this.builder.closeAllIncomplete(this.lastSeenTimeMs);
    this.flushSpans();
    this.flushLinks();
  }

  private see(timestampMs: number | undefined): void {
    if (timestampMs !== undefined && timestampMs > this.lastSeenTimeMs) {
      this.lastSeenTimeMs = timestampMs;
    }
  }

  private onSessionMeta(event: Extract<RawEvent, { type: 'session.meta' }>): void {
    const meta: { cwd?: string; startedAtMs?: number } = {};
    if (event.cwd !== undefined) meta.cwd = event.cwd;
    if (event.startedAtMs !== undefined) meta.startedAtMs = event.startedAtMs;
    this.pipeline._upsertSessionMeta(this.ref, meta);
    this.see(event.startedAtMs);
  }

  private onSpanOpen(event: Extract<RawEvent, { type: 'span.open' }>): void {
    const spanId = spanIdFor(this.traceId, event.sourceRowKey);
    this.keyToSpanId.set(event.key, spanId);
    let parentSpanId: string | undefined;
    if (event.parentKey !== undefined) {
      parentSpanId = this.keyToSpanId.get(event.parentKey);
      if (parentSpanId === undefined) {
        // Parent key not currently open — open as root rather than dropping.
        this.report.warnings += 1;
      }
    }
    const attributes: Record<string, SpanAttributeValue> = {
      [ATTR.SESSION_ID]: this.ref.sessionId,
      [ATTR.SOURCE]: this.ref.source,
      ...(event.attributes ?? {}),
    };
    this.builder.openSpan(event.key, {
      traceId: this.traceId,
      spanId,
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      kind: event.kind,
      name: event.name,
      startTimeMs: event.startTimeMs,
      ...(event.status !== undefined ? { status: event.status } : {}),
      attributes,
      ...(event.events !== undefined ? { events: event.events } : {}),
      ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
      ...(event.agentName !== undefined ? { agentName: event.agentName } : {}),
      ...(event.inputSummary !== undefined
        ? { inputSummary: this.pipeline._redactSummary(event.inputSummary) }
        : {}),
      ...(event.payloadRef !== undefined ? { payloadRef: event.payloadRef } : {}),
    });
    this.see(event.startTimeMs);
    for (const spanEvent of event.events ?? []) this.see(spanEvent.timestampMs);
  }

  private onSpanAttr(event: Extract<RawEvent, { type: 'span.attr' }>): void {
    if (!this.builder.isOpen(event.key)) {
      this.report.warnings += 1;
      return;
    }
    this.builder.updateSpan(event.key, { attributes: event.attributes });
  }

  private onSpanEvent(event: Extract<RawEvent, { type: 'span.event' }>): void {
    if (!this.builder.isOpen(event.key)) {
      this.report.warnings += 1;
      return;
    }
    this.builder.updateSpan(event.key, { events: [event.event] });
    this.see(event.event.timestampMs);
  }

  private onSpanClose(event: Extract<RawEvent, { type: 'span.close' }>): void {
    const closed = this.builder.closeSpan(event.key, {
      endTimeMs: event.endTimeMs,
      ...(event.status !== undefined ? { status: event.status } : {}),
      ...(event.attributes !== undefined ? { attributes: event.attributes } : {}),
      ...(event.events !== undefined ? { events: event.events } : {}),
      ...(event.tokenUsage !== undefined ? { tokenUsage: event.tokenUsage } : {}),
      ...(event.outputSummary !== undefined
        ? { outputSummary: this.pipeline._redactSummary(event.outputSummary) }
        : {}),
      ...(event.payloadRef !== undefined ? { payloadRef: event.payloadRef } : {}),
    });
    if (closed === undefined) this.report.warnings += 1;
    this.see(event.endTimeMs);
  }

  private onLink(event: Extract<RawEvent, { type: 'link' }>): void {
    const fromSpanId = this.keyToSpanId.get(event.fromKey);
    const toSpanId = this.keyToSpanId.get(event.toKey);
    if (fromSpanId === undefined || toSpanId === undefined) {
      this.report.warnings += 1;
      return;
    }
    this.pendingLinks.push({ fromSpanId, toSpanId, kind: event.kind });
  }

  private flushSpans(): void {
    if (this.pendingSpans.length === 0) return;
    const batch = this.pendingSpans;
    this.pendingSpans = [];
    this.pipeline._writeSpans(batch, this.report);
  }

  private flushLinks(): void {
    if (this.pendingLinks.length === 0) return;
    const batch = this.pendingLinks;
    this.pendingLinks = [];
    this.pipeline._writeLinks(batch, this.report);
  }
}
