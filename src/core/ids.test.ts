import { describe, expect, it } from 'vitest';
import { spanIdFor, traceIdFor } from './ids.js';

describe('ids', () => {
  it('traceIdFor is deterministic and 32 hex chars', () => {
    const a = traceIdFor('claude-code', 'session-1');
    const b = traceIdFor('claude-code', 'session-1');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('traceIdFor differs across sources and sessions', () => {
    expect(traceIdFor('codex', 'session-1')).not.toBe(traceIdFor('claude-code', 'session-1'));
    expect(traceIdFor('claude-code', 'session-2')).not.toBe(traceIdFor('claude-code', 'session-1'));
  });

  it('spanIdFor is deterministic and 16 hex chars', () => {
    const traceId = traceIdFor('kimi-code', 'sess');
    const a = spanIdFor(traceId, 'row-42');
    expect(a).toBe(spanIdFor(traceId, 'row-42'));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('spanIdFor is idempotent per source row (re-ingest produces same id)', () => {
    const traceId = traceIdFor('claude-code', 'sess');
    const first = spanIdFor(traceId, 'uuid-abc');
    const second = spanIdFor(traceId, 'uuid-abc');
    expect(first).toBe(second);
    expect(spanIdFor(traceId, 'uuid-abd')).not.toBe(first);
  });

  it('spanIdFor differs across traces for the same row key', () => {
    const t1 = traceIdFor('claude-code', 's1');
    const t2 = traceIdFor('claude-code', 's2');
    expect(spanIdFor(t1, 'row')).not.toBe(spanIdFor(t2, 'row'));
  });
});
