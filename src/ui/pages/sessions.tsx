/**
 * SessionsPage — `/sessions`.
 *
 * Top: aggregate cards (session count / spans / tokens / cost) computed
 * client-side from GET /api/sessions data, source filter tabs, and the
 * full-text SearchBox. Below: the session table (click a row to open the
 * session detail) with simple offset pagination.
 *
 * Aggregation is over the currently loaded page only; when the server-side
 * `total` exceeds the page size the cards are marked 当前页统计.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtCost, fmtTime, fmtTokens } from '../lib/format.js';
import type { SessionSummary, SessionsResponse } from '../lib/types.js';
import { navigate } from '../router.jsx';
import { SearchBox } from '../components/search-box.jsx';
import { StatCard } from '../components/stat-card.jsx';
import { CwdCascader } from '../components/cwd-cascader.jsx';
import { FilterSelect } from '../components/filter-select.jsx';
import { SuccessPanel } from '../components/success-panel.jsx';

const LIMIT = 50;
const SOURCE_TABS = [
  { key: 'all', label: 'All', cls: 'tab-all', color: 'var(--color-platform-all)' },
  { key: 'claude-code', label: 'Claude Code', cls: 'tab-cc', color: 'var(--color-platform-cc)' },
  { key: 'kimi-code', label: 'Kimi Code', cls: 'tab-kimi', color: 'var(--color-platform-kimi)' },
  { key: 'codex', label: 'Codex', cls: 'tab-codex', color: 'var(--color-platform-codex)' },
] as const;
type SourceTab = (typeof SOURCE_TABS)[number]['key'];

const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_OPTIONS = [
  { value: 'all', label: '全部时间' },
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
] as const;
type TimeRange = (typeof TIME_OPTIONS)[number]['value'];

const ERROR_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'error', label: '仅有错误' },
  { value: 'clean', label: '仅无错误' },
] as const;
type ErrorFilter = (typeof ERROR_OPTIONS)[number]['value'];

const BUILD_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'pass', label: '通过' },
  { value: 'fail', label: '失败' },
  { value: 'none', label: '未运行' },
] as const;
type BuildFilter = (typeof BUILD_OPTIONS)[number]['value'];

function timeRangeToFrom(range: TimeRange): number | undefined {
  if (range === '24h') return Date.now() - DAY_MS;
  if (range === '7d') return Date.now() - 7 * DAY_MS;
  if (range === '30d') return Date.now() - 30 * DAY_MS;
  return undefined;
}

// ─── URL 同步:全部过滤状态进 query(replaceState,不污染历史),返回时恢复 ───

export const LAST_URL_KEY = 'tya.lastSessionsUrl';
const SOURCE_KEYS = SOURCE_TABS.map((t) => t.key) as readonly string[];

interface PageState {
  source: SourceTab;
  cwd: string | undefined;
  time: TimeRange;
  error: ErrorFilter;
  build: BuildFilter;
  spanQ: string;
  offset: number;
}

function readUrlState(): PageState {
  const p = new URLSearchParams(window.location.search);
  const rawSource = p.get('source') ?? 'all';
  const rawTime = p.get('time') ?? 'all';
  const rawError = p.get('error') ?? 'all';
  const rawBuild = p.get('build') ?? 'all';
  const rawOffset = Number(p.get('offset') ?? '0');
  return {
    source: (SOURCE_KEYS.includes(rawSource) ? rawSource : 'all') as SourceTab,
    cwd: p.get('cwd') ?? undefined,
    time: (TIME_OPTIONS.some((o) => o.value === rawTime) ? rawTime : 'all') as TimeRange,
    error: (ERROR_OPTIONS.some((o) => o.value === rawError) ? rawError : 'all') as ErrorFilter,
    build: (BUILD_OPTIONS.some((o) => o.value === rawBuild) ? rawBuild : 'all') as BuildFilter,
    spanQ: p.get('spanQ') ?? '',
    offset: Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
  };
}

function writeUrlState(s: PageState): void {
  const p = new URLSearchParams();
  if (s.source !== 'all') p.set('source', s.source);
  if (s.cwd !== undefined) p.set('cwd', s.cwd);
  if (s.time !== 'all') p.set('time', s.time);
  if (s.error !== 'all') p.set('error', s.error);
  if (s.build !== 'all') p.set('build', s.build);
  if (s.spanQ !== '') p.set('spanQ', s.spanQ);
  if (s.offset > 0) p.set('offset', String(s.offset));
  const qs = p.toString();
  const url = `/sessions${qs === '' ? '' : `?${qs}`}`;
  window.history.replaceState(null, '', url);
  try {
    sessionStorage.setItem(LAST_URL_KEY, url);
  } catch {
    /* private mode 等场景下静默 */
  }
}

export function SessionsPage() {
  const [initial] = useState(readUrlState);
  const [source, setSource] = useState<SourceTab>(initial.source);
  const [offset, setOffset] = useState(initial.offset);
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 过滤栏状态
  const [cwd, setCwd] = useState<string | undefined>(initial.cwd);
  const [timeRange, setTimeRange] = useState<TimeRange>(initial.time);
  const [errorFilter, setErrorFilter] = useState<ErrorFilter>(initial.error);
  const [buildFilter, setBuildFilter] = useState<BuildFilter>(initial.build);
  const [spanQ, setSpanQ] = useState(initial.spanQ);
  const [cwds, setCwds] = useState<Array<{ cwd: string; count: number }>>([]);

  useEffect(() => {
    let alive = true;
    api
      .sources()
      .then((d) => {
        if (!alive) return;
        const map: Record<string, number> = { all: d.total };
        for (const s of d.sources) map[s.source] = s.count;
        setCounts(map);
      })
      .catch(() => {
        /* counts are decorative — tab bar works without them */
      });
    return () => {
      alive = false;
    };
  }, []);

  // cwd 级联选项跟随平台 tab
  useEffect(() => {
    let alive = true;
    api
      .cwds(source === 'all' ? undefined : source)
      .then((d) => {
        if (alive) setCwds(d.cwds);
      })
      .catch(() => {
        if (alive) setCwds([]);
      });
    return () => {
      alive = false;
    };
  }, [source]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .sessions({
        source: source === 'all' ? undefined : source,
        limit: LIMIT,
        offset,
        cwd,
        from: timeRangeToFrom(timeRange),
        hasError: errorFilter === 'all' ? undefined : errorFilter === 'error',
        spanQ: spanQ === '' ? undefined : spanQ,
        build: buildFilter === 'all' ? undefined : buildFilter,
      })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setData(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [source, offset, cwd, timeRange, errorFilter, buildFilter, spanQ]);

  // URL 同步(replaceState):detail 返回 / 分享链接时状态不丢
  useEffect(() => {
    writeUrlState({ source, cwd, time: timeRange, error: errorFilter, build: buildFilter, spanQ, offset });
  }, [source, cwd, timeRange, errorFilter, buildFilter, spanQ, offset]);

  const sessions = useMemo(() => data?.sessions ?? [], [data]);
  const total = data?.total ?? 0;
  const partial = total > sessions.length;

  const agg = useMemo(() => {
    let spans = 0;
    let input = 0;
    let output = 0;
    let cost = 0;
    let errors = 0;
    for (const s of sessions) {
      spans += s.spanCount;
      input += s.totalInputTokens;
      output += s.totalOutputTokens;
      cost += s.totalCostUsd;
      errors += s.errorCount;
    }
    return { spans, input, output, cost, errors };
  }, [sessions]);

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: 'var(--spacing-6)' }}>
      {/* Header: title + search */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-4)',
          flexWrap: 'wrap',
          marginBottom: 'var(--spacing-3)',
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-fg-strong)', margin: 0 }}>
          Sessions
        </h1>
        <SearchBox
          source={source}
          onSearch={(q) => {
            setSpanQ(q);
            setOffset(0);
          }}
        />
      </div>

      {/* Platform filter tab bar (counts from /api/sources) */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid var(--color-border-default, #1e293b)',
          marginBottom: 'var(--spacing-4)',
        }}
      >
        {SOURCE_TABS.map((t) => {
          const count = counts[t.key];
          const active = source === t.key;
          return (
            <button
              key={t.key}
              type="button"
              className={`tab ${t.cls}${active ? ' tab-active' : ''}`}
              style={{ fontSize: 13, padding: '8px 14px' }}
              onClick={() => {
                setSource(t.key);
                setOffset(0);
              }}
            >
              {t.label}
              {count !== undefined ? (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 8,
                    background: active ? t.color : 'var(--color-bg-card, #1a1d27)',
                    color: active ? '#fff' : 'var(--color-fg-faint)',
                  }}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* 过滤栏:cwd 级联 + 时间范围 + 错误三态(服务端过滤) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-3)',
          flexWrap: 'wrap',
          marginBottom: 'var(--spacing-4)',
        }}
      >
        <CwdCascader
          cwds={cwds}
          value={cwd}
          onChange={(path) => {
            setCwd(path);
            setOffset(0);
          }}
        />
        <FilterSelect
          label="时间"
          options={TIME_OPTIONS}
          value={timeRange}
          onChange={(v) => {
            setTimeRange(v);
            setOffset(0);
          }}
        />
        <FilterSelect
          label="错误"
          options={ERROR_OPTIONS}
          value={errorFilter}
          onChange={(v) => {
            setErrorFilter(v);
            setOffset(0);
          }}
        />
        <FilterSelect
          label="构建"
          options={BUILD_OPTIONS}
          value={buildFilter}
          onChange={(v) => {
            setBuildFilter(v);
            setOffset(0);
          }}
        />
        {spanQ !== '' ? (
          <span
            className="btn"
            style={{ color: 'var(--color-accent)', display: 'inline-flex', alignItems: 'center' }}
            title="表格已按 span 内容过滤"
          >
            内容: {spanQ}
            <span
              role="button"
              tabIndex={-1}
              style={{ marginLeft: 8, color: 'var(--color-fg-faint)', cursor: 'pointer' }}
              onClick={() => {
                setSpanQ('');
                setOffset(0);
              }}
            >
              ✕
            </span>
          </span>
        ) : null}
        {(cwd !== undefined || timeRange !== 'all' || errorFilter !== 'all' || buildFilter !== 'all' || spanQ !== '') && (
          <button
            type="button"
            className="btn"
            style={{ color: 'var(--color-fg-faint)' }}
            onClick={() => {
              setCwd(undefined);
              setTimeRange('all');
              setErrorFilter('all');
              setBuildFilter('all');
              setSpanQ('');
              setOffset(0);
            }}
          >
            清除过滤
          </button>
        )}
      </div>

      {/* 成功率面板(基于人工标注,可折叠) */}
      <SuccessPanel />

      {/* Aggregate cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: 'var(--spacing-3)',
          marginBottom: 4,
        }}
      >
        <StatCard label="Sessions" value={String(total)} sub={partial ? `当前页 ${sessions.length} 条` : undefined} />
        <StatCard
          label="Spans"
          value={fmtTokens(agg.spans)}
          sub={partial ? '当前页统计' : undefined}
          tone="var(--color-kind-llm)"
        />
        <StatCard
          label="Tokens"
          value={fmtTokens(agg.input + agg.output)}
          sub={`↑${fmtTokens(agg.input)} ↓${fmtTokens(agg.output)}${partial ? ' · 当前页统计' : ''}`}
          tone="var(--color-kind-agent)"
        />
        <StatCard
          label="Cost"
          value={fmtCost(agg.cost)}
          sub={`errors ${agg.errors}${partial ? ' · 当前页统计' : ''}`}
          tone="var(--color-kind-tool)"
        />
      </div>
      {partial ? (
        <div style={{ fontSize: 10, color: 'var(--color-fg-faint)', marginBottom: 'var(--spacing-3)' }}>
          * 除 Sessions 外均为当前页统计(共 {total} 个 session,当前显示 {offset + 1}–{offset + sessions.length})
        </div>
      ) : (
        <div style={{ marginBottom: 'var(--spacing-3)' }} />
      )}

      {/* Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {error ? (
          <StateBox tone="error" text={`加载失败:${error}`} />
        ) : loading && sessions.length === 0 ? (
          <StateBox text="加载中…" />
        ) : sessions.length === 0 ? (
          <StateBox text="没有 session。先用 CLI ingest 一些 agent 日志。" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>session</th>
                <th>source</th>
                <th>开始时间</th>
                <th>cwd</th>
                <th style={{ textAlign: 'right' }}>spans</th>
                <th style={{ textAlign: 'right' }}>turns</th>
                <th style={{ textAlign: 'right' }}>tokens (in+out)</th>
                <th style={{ textAlign: 'right' }}>成本</th>
                <th style={{ textAlign: 'right' }}>错误</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <SessionRow key={s.sessionId} s={s} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {total > LIMIT ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--spacing-3)',
            marginTop: 'var(--spacing-3)',
            justifyContent: 'flex-end',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-fg-muted)',
          }}
        >
          <span>
            {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
          </span>
          <button
            type="button"
            className="btn"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
          >
            ← prev
          </button>
          <button
            type="button"
            className="btn"
            disabled={offset + LIMIT >= total}
            onClick={() => setOffset(offset + LIMIT)}
          >
            next →
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SessionRow({ s }: { s: SessionSummary }) {
  const hasError = s.errorCount > 0;
  return (
    <tr onClick={() => navigate(`/sessions/${encodeURIComponent(s.sessionId)}`)}>
      <td>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-accent)',
            fontSize: 12,
          }}
          title={s.sessionId}
        >
          {s.sessionId.length > 16 ? `${s.sessionId.slice(0, 16)}…` : s.sessionId}
        </span>
        {s.spanHits !== undefined ? (
          <span
            title={`${s.spanHits} 处 span 命中`}
            style={{
              marginLeft: 6,
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              padding: '1px 6px',
              borderRadius: 8,
              background: 'color-mix(in srgb, var(--color-accent) 18%, transparent)',
              color: 'var(--color-accent)',
            }}
          >
            {s.spanHits} 命中
          </span>
        ) : null}
        {s.buildStatus === 'pass' || s.buildStatus === 'fail' ? (
          <span
            title={s.buildStatus === 'pass' ? '检测到测试/构建命令:通过' : '检测到测试/构建命令:失败'}
            style={{
              marginLeft: 6,
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              padding: '1px 6px',
              borderRadius: 8,
              background:
                s.buildStatus === 'pass'
                  ? 'color-mix(in srgb, var(--color-status-ok) 16%, transparent)'
                  : 'color-mix(in srgb, var(--color-status-error) 16%, transparent)',
              color:
                s.buildStatus === 'pass' ? 'var(--color-status-ok)' : 'var(--color-status-error)',
            }}
          >
            {s.buildStatus === 'pass' ? '✓ 构建' : '✗ 构建'}
          </span>
        ) : null}
      </td>
      <td>
        <span
          className={srcClass(s.source)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500 }}
        >
          {s.source}
        </span>
      </td>
      <td>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-fg-muted)' }}>
          {s.startedAtMs !== undefined ? fmtTime(s.startedAtMs) : '—'}
        </span>
      </td>
      <td>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--color-fg-faint)',
            display: 'inline-block',
            maxWidth: 320,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            verticalAlign: 'bottom',
          }}
          title={s.cwd}
        >
          {s.cwd ?? '—'}
        </span>
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {s.spanCount}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {s.turnCount}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {fmtTokens(s.totalInputTokens + s.totalOutputTokens)}
        <span style={{ color: 'var(--color-fg-faint)', fontSize: 10 }}>
          {' '}
          (↑{fmtTokens(s.totalInputTokens)} ↓{fmtTokens(s.totalOutputTokens)})
        </span>
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {fmtCost(s.totalCostUsd)}
      </td>
      <td
        style={{
          textAlign: 'right',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: hasError ? 'var(--color-status-error)' : 'var(--color-fg-faint)',
          fontWeight: hasError ? 600 : 400,
        }}
      >
        {s.errorCount}
      </td>
    </tr>
  );
}

function srcClass(source: string): string | undefined {
  if (source === 'claude-code') return 'src-cc';
  if (source === 'kimi-code') return 'src-kimi';
  if (source === 'codex') return 'src-codex';
  return undefined;
}

function StateBox({ text, tone }: { text: string; tone?: 'error' | undefined }) {
  return (
    <div
      style={{
        padding: 'var(--spacing-8)',
        textAlign: 'center',
        fontSize: 13,
        color: tone === 'error' ? 'var(--color-status-error)' : 'var(--color-fg-faint)',
      }}
    >
      {text}
    </div>
  );
}
