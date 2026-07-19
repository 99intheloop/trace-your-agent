import { describe, expect, it } from 'vitest';
import { ATTR, type Span } from '../core/types.js';
import { TraceStore } from './store.js';

function span(spanId: string, sessionId: string, startMs: number, source = 'claude-code'): Span {
  return {
    traceId: 't'.repeat(32),
    spanId,
    kind: 'SESSION',
    name: 'session',
    startTimeMs: startMs,
    durationMs: 100,
    status: { code: 'ok' },
    attributes: { [ATTR.SESSION_ID]: sessionId, [ATTR.SOURCE]: source },
  };
}

describe('setVerdict', () => {
  it('写入/局部更新/null 清除', () => {
    const store = new TraceStore(':memory:');
    store.insertSpans([span('a'.repeat(16), 's1', 1000)]);
    expect(store.setVerdict('s1', { verdict: 'pass', taskType: 'feature', note: 'done' })).toBe(true);
    let row = store.getSessionRow('s1');
    expect(row?.verdict).toBe('pass');
    expect(row?.taskType).toBe('feature');
    expect(row?.note).toBe('done');
    // 局部更新:只改 verdict,其他不动
    store.setVerdict('s1', { verdict: 'partial' });
    row = store.getSessionRow('s1');
    expect(row?.verdict).toBe('partial');
    expect(row?.taskType).toBe('feature');
    // null 清除
    store.setVerdict('s1', { note: null });
    expect(store.getSessionRow('s1')?.note).toBeNull();
    // 不存在的 session
    expect(store.setVerdict('nope', { verdict: 'pass' })).toBe(false);
    store.close();
  });

  it('re-ingest(recompute)后标注保留', () => {
    const store = new TraceStore(':memory:');
    store.insertSpans([span('a'.repeat(16), 's1', 1000)]);
    store.setVerdict('s1', { verdict: 'fail', taskType: 'fix', note: 'broken' });
    // 同 session 再进新 span → 触发 recomputeSession 全量重建聚合
    store.insertSpans([span('b'.repeat(16), 's1', 2000)]);
    const row = store.getSessionRow('s1');
    expect(row?.spanCount).toBe(2);
    expect(row?.verdict).toBe('fail');
    expect(row?.taskType).toBe('fix');
    expect(row?.note).toBe('broken');
    store.close();
  });
});

describe('successStats', () => {
  it('按 source / taskType / week 聚合,仅统计已标注', () => {
    const store = new TraceStore(':memory:');
    store.insertSpans([
      span('a'.repeat(16), 's1', Date.parse('2026-07-06T10:00:00Z')),
      span('b'.repeat(16), 's2', Date.parse('2026-07-06T11:00:00Z'), 'codex'),
      span('c'.repeat(16), 's3', Date.parse('2026-07-13T10:00:00Z'), 'codex'),
    ]);
    store.setVerdict('s1', { verdict: 'pass', taskType: 'feature' });
    store.setVerdict('s2', { verdict: 'fail', taskType: 'fix' });
    store.setVerdict('s3', { verdict: 'pass' }); // taskType 留空
    // s4 未标注 → 不计入
    store.insertSpans([span('d'.repeat(16), 's4', 1000)]);

    const bySource = store.successStats('source');
    const cc = bySource.find((r) => r.key === 'claude-code');
    const cx = bySource.find((r) => r.key === 'codex');
    expect(cc?.total).toBe(1);
    expect(cc?.pass).toBe(1);
    expect(cx?.total).toBe(2);
    expect(cx?.fail).toBe(1);

    const byType = store.successStats('taskType');
    expect(byType.find((r) => r.key === 'feature')?.total).toBe(1);
    expect(byType.find((r) => r.key === 'fix')?.total).toBe(1);
    expect(byType.find((r) => r.key === '(unlabeled)')?.total).toBe(1);

    const byWeek = store.successStats('week');
    expect(byWeek.length).toBe(2);
    expect(byWeek[0]?.total).toBe(2); // 2026-W28
    expect(byWeek[1]?.total).toBe(1); // 2026-W29
    store.close();
  });
});
