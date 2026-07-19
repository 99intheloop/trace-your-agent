import { describe, expect, it } from 'vitest';
import { ATTR, type Span } from '../core/types.js';
import { buildCommandSql, reduceBuildStatus } from './build-status.js';
import { TraceStore } from './store.js';

function bashSpan(
  spanId: string,
  sessionId: string,
  command: string,
  ok: boolean,
  toolName = 'Bash',
): Span {
  return {
    traceId: 't'.repeat(32),
    spanId,
    kind: 'TOOL_CALL',
    name: toolName,
    toolName,
    startTimeMs: 1000,
    durationMs: 100,
    status: ok ? { code: 'ok' } : { code: 'error', message: 'exit 1' },
    attributes: { [ATTR.SESSION_ID]: sessionId, [ATTR.SOURCE]: 'claude-code' },
    inputSummary: JSON.stringify({ command }),
  };
}

function sessionSpan(spanId: string, sessionId: string): Span {
  return {
    traceId: 't'.repeat(32),
    spanId,
    kind: 'SESSION',
    name: 'session',
    startTimeMs: 900,
    durationMs: 10000,
    status: { code: 'ok' },
    attributes: { [ATTR.SESSION_ID]: sessionId, [ATTR.SOURCE]: 'claude-code' },
  };
}

function seed(): TraceStore {
  const store = new TraceStore(':memory:');
  store.insertSpans([
    sessionSpan('s'.repeat(16), 'sess-pass'),
    bashSpan('a'.repeat(16), 'sess-pass', 'cd repo && pnpm test 2>&1', true),
    bashSpan('b'.repeat(16), 'sess-pass', 'npm run build', true),
    sessionSpan('t'.repeat(16), 'sess-fail'),
    bashSpan('c'.repeat(16), 'sess-fail', 'pytest tests/', false),
    sessionSpan('u'.repeat(16), 'sess-none'),
    bashSpan('d'.repeat(16), 'sess-none', 'ls -la', true),
    // Read 工具即使文本命中模式也不算(工具白名单)
    {
      ...bashSpan('e'.repeat(16), 'sess-none', 'write npm test docs', true, 'Read'),
    },
  ]);
  return store;
}

describe('reduceBuildStatus', () => {
  it('fail > pass > none', () => {
    expect(reduceBuildStatus(2, 1)).toBe('fail');
    expect(reduceBuildStatus(2, 0)).toBe('pass');
    expect(reduceBuildStatus(0, 0)).toBe('none');
  });
});

describe('buildCommandSql', () => {
  it('参数化生成 IN 与 LIKE 条件', () => {
    const { where, params } = buildCommandSql();
    expect(where).toContain('tool_name IN');
    expect(where).toContain('LIKE');
    expect(Object.values(params)).toContain('Bash');
    expect(Object.values(params)).toContain('%pnpm test%');
  });
});

describe('buildStatusByIds + listSessions buildStatus filter', () => {
  it('按命令与 span 状态派生 pass/fail;未命中即 none', () => {
    const store = seed();
    const map = store.buildStatusByIds(['sess-pass', 'sess-fail', 'sess-none']);
    expect(map.get('sess-pass')).toBe('pass');
    expect(map.get('sess-fail')).toBe('fail');
    expect(map.has('sess-none')).toBe(false);
    store.close();
  });

  it('过滤 pass / fail / none 三种取值', () => {
    const store = seed();
    const ids = (rows: Array<{ sessionId: string }>) => rows.map((r) => r.sessionId).sort();
    expect(ids(store.listSessions({ buildStatus: 'pass' }))).toEqual(['sess-pass']);
    expect(ids(store.listSessions({ buildStatus: 'fail' }))).toEqual(['sess-fail']);
    expect(ids(store.listSessions({ buildStatus: 'none' }))).toEqual(['sess-none']);
    expect(store.countSessions({ buildStatus: 'pass' })).toBe(1);
    store.close();
  });
});
