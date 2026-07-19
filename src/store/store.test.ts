import { describe, expect, it } from 'vitest';
import { ATTR, type Span } from '../core/types.js';
import { TraceStore } from './store.js';

function makeSpan(overrides: Partial<Span> & { spanId: string }): Span {
  const base: Span = {
    traceId: 't'.repeat(32),
    spanId: overrides.spanId,
    kind: 'LLM_CALL',
    name: 'chat',
    startTimeMs: 1000,
    durationMs: 100,
    status: { code: 'ok' },
    attributes: {
      [ATTR.SESSION_ID]: 'sess-1',
      [ATTR.SOURCE]: 'claude-code',
      [ATTR.JOIN_QUALITY]: 'structural',
    },
  };
  return { ...base, ...overrides, attributes: { ...base.attributes, ...overrides.attributes } };
}

function fixtureSpans(): Span[] {
  const session = makeSpan({
    spanId: 'a'.repeat(16),
    kind: 'SESSION',
    name: 'session',
    startTimeMs: 1000,
    durationMs: 9000,
    attributes: { [ATTR.AGENT_ID]: 'main' },
  });
  const turn = makeSpan({
    spanId: 'b'.repeat(16),
    kind: 'AGENT_TURN',
    name: 'turn-1',
    startTimeMs: 1100,
    durationMs: 5000,
    parentSpanId: session.spanId,
    attributes: { [ATTR.AGENT_ID]: 'main' },
  });
  const llm = makeSpan({
    spanId: 'c'.repeat(16),
    kind: 'LLM_CALL',
    name: 'claude chat',
    startTimeMs: 1200,
    durationMs: 2000,
    parentSpanId: turn.spanId,
    attributes: { [ATTR.AGENT_ID]: 'main', [ATTR.GEN_AI_MODEL]: 'claude-sonnet-4-5' },
    tokenUsage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000 },
    inputSummary: 'fix the flaky test',
    outputSummary: 'patched store.ts',
  });
  const tool = makeSpan({
    spanId: 'd'.repeat(16),
    kind: 'TOOL_CALL',
    name: 'Edit',
    startTimeMs: 3300,
    durationMs: 50,
    parentSpanId: turn.spanId,
    toolName: 'Edit',
    attributes: { [ATTR.AGENT_ID]: 'main', [ATTR.JOIN_QUALITY]: 'heuristic' },
  });
  const failed = makeSpan({
    spanId: 'e'.repeat(16),
    kind: 'TOOL_CALL',
    name: 'Bash',
    startTimeMs: 3400,
    durationMs: 60,
    parentSpanId: turn.spanId,
    toolName: 'Bash',
    status: { code: 'error', message: 'exit 1' },
    attributes: { [ATTR.AGENT_ID]: 'sub-1', [ATTR.INCOMPLETE]: true },
  });
  return [session, turn, llm, tool, failed];
}

describe('TraceStore', () => {
  it('inserts spans and reads them back by session id or trace id', () => {
    const store = new TraceStore(':memory:');
    store.insertSpans(fixtureSpans());

    const bySession = store.getSessionSpans('sess-1');
    const byTrace = store.getSessionSpans('t'.repeat(32));
    expect(bySession).toHaveLength(5);
    expect(byTrace).toHaveLength(5);

    const llm = bySession.find((s) => s.spanId === 'c'.repeat(16))!;
    expect(llm.parentSpanId).toBe('b'.repeat(16));
    expect(llm.tokenUsage).toEqual({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000 });
    expect(llm.attributes[ATTR.GEN_AI_MODEL]).toBe('claude-sonnet-4-5');
    expect(llm.inputSummary).toBe('fix the flaky test');
    store.close();
  });

  it('is idempotent: re-inserting the same spans keeps counts stable', () => {
    const store = new TraceStore(':memory:');
    store.insertSpans(fixtureSpans());
    store.insertSpans(fixtureSpans());
    expect(store.getSessionSpans('sess-1')).toHaveLength(5);
    expect(store.getSessionRow('sess-1')!.spanCount).toBe(5);
    store.close();
  });

  it('maintains the sessions aggregate (tokens, turns, agents, errors, cost, join quality)', () => {
    const store = new TraceStore(':memory:');
    store.upsertSessionMeta('sess-1', 'claude-code', { cwd: '/repo', startedAtMs: 1000 });
    store.insertSpans(fixtureSpans());

    const row = store.getSessionRow('sess-1')!;
    expect(row.cwd).toBe('/repo');
    expect(row.startedAtMs).toBe(1000);
    expect(row.spanCount).toBe(5);
    expect(row.turnCount).toBe(1);
    expect(row.agentCount).toBe(2); // main + sub-1
    expect(row.totalInputTokens).toBe(1_000_000);
    expect(row.totalOutputTokens).toBe(100_000);
    expect(row.errorCount).toBe(1);
    // 1M in ($3) + 0.1M out ($1.5) + 2M cache read ($0.6) on sonnet
    expect(row.totalCostUsd).toBeCloseTo(5.1, 10);
    expect(row.joinQualityStats).toEqual({ structural: 4, heuristic: 1 });
    store.close();
  });

  it('listSessions filters by source and time range and sorts', () => {
    const store = new TraceStore(':memory:');
    store.insertSpans(fixtureSpans());
    store.insertSpans([
      makeSpan({
        spanId: 'f'.repeat(16),
        kind: 'SESSION',
        name: 'other',
        startTimeMs: 5000,
        attributes: { [ATTR.SESSION_ID]: 'sess-2', [ATTR.SOURCE]: 'codex' },
      }),
    ]);

    expect(store.listSessions()).toHaveLength(2);
    expect(store.listSessions({ source: 'codex' }).map((s) => s.sessionId)).toEqual(['sess-2']);
    expect(store.listSessions({ fromMs: 4000 }).map((s) => s.sessionId)).toEqual(['sess-2']);
    expect(store.listSessions({ toMs: 4000 }).map((s) => s.sessionId)).toEqual(['sess-1']);
    const byCount = store.listSessions({ orderBy: 'span_count', order: 'desc' });
    expect(byCount[0]!.sessionId).toBe('sess-1');
    expect(store.listSessions({ limit: 1 })).toHaveLength(1);
    store.close();
  });

  it('searchSpans full-text matches summaries/names with filters', () => {
    const store = new TraceStore(':memory:');
    store.insertSpans(fixtureSpans());

    const hits = store.searchSpans('flaky');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.spanId).toBe('c'.repeat(16));

    expect(store.searchSpans('flaky', { kind: 'TOOL_CALL' })).toHaveLength(0);
    expect(store.searchSpans('patched', { sessionId: 'sess-1' })).toHaveLength(1);
    expect(store.searchSpans('Edit')).toHaveLength(1); // tool_name is indexed
    expect(store.searchSpans('&&&')).toHaveLength(0); // no usable tokens
    store.close();
  });

  it('getLinks returns links within the trace', () => {
    const store = new TraceStore(':memory:');
    store.insertSpans(fixtureSpans());
    store.insertLinks([
      { fromSpanId: 'b'.repeat(16), toSpanId: 'e'.repeat(16), kind: 'NOTIFY' },
      { fromSpanId: 'b'.repeat(16), toSpanId: 'e'.repeat(16), kind: 'NOTIFY' }, // dup ignored
    ]);

    const links = store.getLinks('t'.repeat(32));
    expect(links).toEqual([{ fromSpanId: 'b'.repeat(16), toSpanId: 'e'.repeat(16), kind: 'NOTIFY' }]);
    expect(store.getLinks('0'.repeat(32))).toEqual([]);
    store.close();
  });

  it('getStats computes live per-session stats', () => {
    const store = new TraceStore(':memory:');
    store.insertSpans(fixtureSpans());

    const stats = store.getStats('sess-1');
    expect(stats.spanCount).toBe(5);
    expect(stats.byKind).toEqual({ SESSION: 1, AGENT_TURN: 1, LLM_CALL: 1, TOOL_CALL: 2 });
    expect(stats.totalInputTokens).toBe(1_000_000);
    expect(stats.totalCacheReadTokens).toBe(2_000_000);
    expect(stats.errorCount).toBe(1);
    expect(stats.incompleteCount).toBe(1);
    expect(stats.totalCostUsd).toBeCloseTo(5.1, 10);
    expect(stats.topTools).toEqual([
      { toolName: 'Bash', count: 1 },
      { toolName: 'Edit', count: 1 },
    ]);
    store.close();
  });
});
