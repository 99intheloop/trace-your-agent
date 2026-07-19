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

const LIMIT = 50;
const SOURCE_TABS = [
  { key: 'all', label: 'All' },
  { key: 'claude-code', label: 'Claude Code' },
  { key: 'kimi-code', label: 'Kimi Code' },
  { key: 'codex', label: 'Codex' },
] as const;
type SourceTab = (typeof SOURCE_TABS)[number]['key'];

export function SessionsPage() {
  const [source, setSource] = useState<SourceTab>('all');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .sessions({ source: source === 'all' ? undefined : source, limit: LIMIT, offset })
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
  }, [source, offset]);

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
        <SearchBox source={source} />
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
          return (
            <button
              key={t.key}
              type="button"
              className={`tab${source === t.key ? ' tab-active' : ''}`}
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
                    background:
                      source === t.key ? 'var(--color-accent)' : 'var(--color-bg-card, #1a1d27)',
                    color: source === t.key ? '#fff' : 'var(--color-fg-faint)',
                  }}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

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
        />
        <StatCard
          label="Tokens"
          value={fmtTokens(agg.input + agg.output)}
          sub={`↑${fmtTokens(agg.input)} ↓${fmtTokens(agg.output)}${partial ? ' · 当前页统计' : ''}`}
        />
        <StatCard
          label="Cost"
          value={fmtCost(agg.cost)}
          sub={`errors ${agg.errors}${partial ? ' · 当前页统计' : ''}`}
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
      </td>
      <td>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-fg-muted)' }}>
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
