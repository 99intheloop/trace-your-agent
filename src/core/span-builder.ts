import { ATTR, type Span, type SpanAttributeValue, type SpanEvent, type SpanKind, type SpanStatus, type TokenUsage } from './types.js';

/**
 * Event-driven span builder.
 *
 * Adapters emit open/close events keyed by an adapter-chosen handle (e.g. a
 * `tool_use` id from the source log). The builder owns the set of currently
 * open spans and produces completed, well-formed {@link Span}s.
 *
 * Completion paths:
 * - {@link closeSpan}: normal close with an explicit end time.
 * - {@link closeAllIncomplete}: end-of-file cleanup. Anything still open is
 *   closed with `incomplete: true` and `durationMs = lastSeenTimeMs - startTimeMs`.
 */
export interface OpenSpanInit {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: SpanKind;
  name: string;
  startTimeMs: number;
  status?: SpanStatus;
  attributes?: Record<string, SpanAttributeValue>;
  events?: SpanEvent[];
  tokenUsage?: TokenUsage;
  toolName?: string;
  inputSummary?: string;
  outputSummary?: string;
  agentName?: string;
  payloadRef?: string;
}

export interface CloseSpanUpdate {
  /** Required for a normal close; durationMs = endTimeMs - startTimeMs. */
  endTimeMs: number;
  status?: SpanStatus;
  /** Merged over the attributes given at open time. */
  attributes?: Record<string, SpanAttributeValue>;
  /** Appended to the events given at open time. */
  events?: SpanEvent[];
  tokenUsage?: TokenUsage;
  outputSummary?: string;
  payloadRef?: string;
}

export type SpanListener = (span: Span) => void;

export class SpanBuilder {
  private readonly open = new Map<string, OpenSpanInit>();
  private readonly completed: Span[] = [];
  private readonly listeners: SpanListener[] = [];

  /** Register a listener fired for every completed span (close or cleanup). */
  onSpan(listener: SpanListener): this {
    this.listeners.push(listener);
    return this;
  }

  /**
   * Open a span under `key`. Throws if the key is already open — adapter keys
   * must be unique among in-flight spans.
   */
  openSpan(key: string, init: OpenSpanInit): void {
    if (this.open.has(key)) {
      throw new Error(`span key already open: ${key}`);
    }
    this.open.set(key, { ...init });
  }

  /** Patch an open span in place (merge attributes, append events). No-op if missing. */
  updateSpan(
    key: string,
    update: {
      attributes?: Record<string, SpanAttributeValue>;
      events?: SpanEvent[];
      status?: SpanStatus;
    },
  ): void {
    const entry = this.open.get(key);
    if (!entry) return;
    if (update.attributes) {
      entry.attributes = { ...entry.attributes, ...update.attributes };
    }
    if (update.events) {
      entry.events = [...(entry.events ?? []), ...update.events];
    }
    if (update.status) {
      entry.status = update.status;
    }
  }

  /** Close a span normally. Returns the completed span, or `undefined` if the key is not open. */
  closeSpan(key: string, update: CloseSpanUpdate): Span | undefined {
    const entry = this.open.get(key);
    if (!entry) return undefined;
    this.open.delete(key);
    const span = this.materialize(entry, update, update.endTimeMs);
    return this.emit(span);
  }

  /**
   * End-of-file cleanup: close every still-open span as incomplete.
   * durationMs is clamped to >= 0 for out-of-order timestamps.
   * Returns the completed spans in open order.
   */
  closeAllIncomplete(lastSeenTimeMs: number): Span[] {
    const closed: Span[] = [];
    for (const entry of this.open.values()) {
      const span = this.materialize(
        {
          ...entry,
          attributes: { ...entry.attributes, [ATTR.INCOMPLETE]: true },
        },
        { endTimeMs: lastSeenTimeMs },
        lastSeenTimeMs,
      );
      closed.push(this.emit(span));
    }
    this.open.clear();
    return closed;
  }

  isOpen(key: string): boolean {
    return this.open.has(key);
  }

  get openCount(): number {
    return this.open.size;
  }

  /** All completed spans so far, in completion order. */
  get spans(): readonly Span[] {
    return this.completed;
  }

  private materialize(
    init: OpenSpanInit,
    update: CloseSpanUpdate,
    endTimeMs: number,
  ): Span {
    const durationMs = Math.max(0, endTimeMs - init.startTimeMs);
    const attributes = { ...init.attributes, ...update.attributes };
    const events = [...(init.events ?? []), ...(update.events ?? [])];
    const span: Span = {
      traceId: init.traceId,
      spanId: init.spanId,
      kind: init.kind,
      name: init.name,
      startTimeMs: init.startTimeMs,
      durationMs,
      status: update.status ?? init.status ?? { code: 'ok' },
      attributes,
    };
    if (init.parentSpanId !== undefined) span.parentSpanId = init.parentSpanId;
    if (events.length > 0) span.events = events;
    const tokenUsage = update.tokenUsage ?? init.tokenUsage;
    if (tokenUsage !== undefined) span.tokenUsage = tokenUsage;
    if (init.toolName !== undefined) span.toolName = init.toolName;
    if (init.inputSummary !== undefined) span.inputSummary = init.inputSummary;
    const outputSummary = update.outputSummary ?? init.outputSummary;
    if (outputSummary !== undefined) span.outputSummary = outputSummary;
    if (init.agentName !== undefined) span.agentName = init.agentName;
    const payloadRef = update.payloadRef ?? init.payloadRef;
    if (payloadRef !== undefined) span.payloadRef = payloadRef;
    return span;
  }

  private emit(span: Span): Span {
    this.completed.push(span);
    for (const listener of this.listeners) listener(span);
    return span;
  }
}
