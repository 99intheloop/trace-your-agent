import { describe, expect, it } from 'vitest';
import { SpanBuilder, type OpenSpanInit } from './span-builder.js';
import type { Span } from './types.js';

const base: OpenSpanInit = {
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  kind: 'TOOL_CALL',
  name: 'Bash',
  startTimeMs: 1000,
};

describe('SpanBuilder', () => {
  it('open/close produces a completed span with computed duration', () => {
    const builder = new SpanBuilder();
    builder.openSpan('k1', base);
    expect(builder.isOpen('k1')).toBe(true);

    const span = builder.closeSpan('k1', { endTimeMs: 1600 });
    expect(span).toBeDefined();
    expect(span!.durationMs).toBe(600);
    expect(span!.status).toEqual({ code: 'ok' });
    expect(builder.isOpen('k1')).toBe(false);
    expect(builder.spans).toHaveLength(1);
  });

  it('close merges attributes, appends events, sets output', () => {
    const builder = new SpanBuilder();
    builder.openSpan('k1', { ...base, attributes: { a: 1 }, events: [{ name: 'e1', timestampMs: 1100 }] });
    const span = builder.closeSpan('k1', {
      endTimeMs: 2000,
      attributes: { b: 2 },
      events: [{ name: 'e2', timestampMs: 1900 }],
      outputSummary: 'done',
      status: { code: 'error', message: 'boom' },
    });
    expect(span!.attributes).toEqual({ a: 1, b: 2 });
    expect(span!.events!.map((e) => e.name)).toEqual(['e1', 'e2']);
    expect(span!.outputSummary).toBe('done');
    expect(span!.status).toEqual({ code: 'error', message: 'boom' });
  });

  it('updateSpan patches an open span', () => {
    const builder = new SpanBuilder();
    builder.openSpan('k1', { ...base, attributes: { a: 1 } });
    builder.updateSpan('k1', { attributes: { b: 2 }, events: [{ name: 'e', timestampMs: 1200 }] });
    const span = builder.closeSpan('k1', { endTimeMs: 2000 });
    expect(span!.attributes).toEqual({ a: 1, b: 2 });
    expect(span!.events).toHaveLength(1);
  });

  it('duplicate open key throws; close of unknown key is undefined', () => {
    const builder = new SpanBuilder();
    builder.openSpan('k1', base);
    expect(() => builder.openSpan('k1', base)).toThrow(/already open/);
    expect(builder.closeSpan('nope', { endTimeMs: 1 })).toBeUndefined();
  });

  it('closeAllIncomplete closes everything with incomplete: true and lastSeen duration', () => {
    const builder = new SpanBuilder();
    builder.openSpan('k1', base);
    builder.openSpan('k2', { ...base, spanId: 'c'.repeat(16), startTimeMs: 1500, kind: 'LLM_CALL', name: 'call' });
    const closed = builder.closeAllIncomplete(3000);

    expect(closed).toHaveLength(2);
    expect(builder.openCount).toBe(0);
    const [s1, s2] = closed as [Span, Span];
    expect(s1.attributes['incomplete']).toBe(true);
    expect(s1.durationMs).toBe(2000);
    expect(s2.durationMs).toBe(1500);
  });

  it('closeAllIncomplete clamps negative durations to 0', () => {
    const builder = new SpanBuilder();
    builder.openSpan('k1', { ...base, startTimeMs: 5000 });
    const [span] = builder.closeAllIncomplete(3000);
    expect(span!.durationMs).toBe(0);
  });

  it('onSpan listener fires on both close paths', () => {
    const seen: Span[] = [];
    const builder = new SpanBuilder().onSpan((s) => seen.push(s));
    builder.openSpan('k1', base);
    builder.openSpan('k2', { ...base, spanId: 'c'.repeat(16) });
    builder.closeSpan('k1', { endTimeMs: 2000 });
    builder.closeAllIncomplete(2500);
    expect(seen.map((s) => s.spanId)).toEqual(['b'.repeat(16), 'c'.repeat(16)]);
  });

  it('keeps optional fields when provided', () => {
    const builder = new SpanBuilder();
    builder.openSpan('k1', {
      ...base,
      parentSpanId: 'd'.repeat(16),
      toolName: 'Bash',
      inputSummary: 'ls',
      agentName: 'main',
      payloadRef: 'payloads/x.json',
      tokenUsage: { inputTokens: 1, outputTokens: 2 },
    });
    const span = builder.closeSpan('k1', { endTimeMs: 2000, tokenUsage: { inputTokens: 3, outputTokens: 4 } });
    expect(span!.parentSpanId).toBe('d'.repeat(16));
    expect(span!.toolName).toBe('Bash');
    expect(span!.inputSummary).toBe('ls');
    expect(span!.agentName).toBe('main');
    expect(span!.payloadRef).toBe('payloads/x.json');
    expect(span!.tokenUsage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });
});
