/**
 * SessionDetailPage — `/sessions/:sessionId` (optionally `?span=<spanId>`).
 *
 * Header: session meta + aggregate cards (duration / spans / tokens / cost /
 * errors) + joinQuality distribution. Body: span tree on the left, span
 * detail panel on the right, with a draggable width divider.
 *
 * `?span=` (set by the search box) selects, scrolls to and flashes that span.
 * Link jump targets (NOTIFY/MESSAGE) reuse the same mechanism.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { api } from '../lib/api.js';
import { fmtCost, fmtMs, fmtTime, fmtTokens } from '../lib/format.js';
import { traceWindow } from '../lib/tree.js';
import { ATTR, attrString } from '../lib/types.js';
import type { SessionSummary, SpansResponse } from '../lib/types.js';
import { navigate } from '../router.jsx';
import { LAST_URL_KEY } from './sessions.jsx';
import { SpanDetail } from '../components/span-detail.jsx';
import { SpanTree } from '../components/span-tree.jsx';
import { StatCard } from '../components/stat-card.jsx';

export function SessionDetailPage({
  sessionId,
  highlightSpanId,
}: {
  sessionId: string;
  highlightSpanId: string | null;
}) {
  const [spansData, setSpansData] = useState<SpansResponse | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [flashSpanId, setFlashSpanId] = useState<string | null>(null);
  const [forceExpandedIds, setForceExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [panelWidth, setPanelWidth] = useState(460);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .spans(sessionId)
      .then((d) => {
        if (!alive) return;
        setSpansData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    // The summary powers the header meta; the tree still renders without it.
    api
      .session(sessionId)
      .then((s) => {
        if (alive) setSummary(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const spans = useMemo(() => spansData?.spans ?? [], [spansData]);
  const links = useMemo(() => spansData?.links ?? [], [spansData]);

  const spansById = useMemo(() => new Map(spans.map((s) => [s.spanId, s])), [spans]);
  const linkedIds = useMemo(() => {
    const set = new Set<string>();
    for (const l of links) {
      set.add(l.fromSpanId);
      set.add(l.toSpanId);
    }
    return set;
  }, [links]);
  const window_ = useMemo(() => traceWindow(spans), [spans]);
  const maxDurationMs = useMemo(
    () => spans.reduce((m, s) => Math.max(m, s.durationMs), 1),
    [spans],
  );

  const stats = useMemo(() => {
    let input = 0;
    let output = 0;
    let errors = 0;
    const joinQuality: Record<string, number> = {};
    for (const s of spans) {
      if (s.tokenUsage) {
        input += s.tokenUsage.inputTokens;
        output += s.tokenUsage.outputTokens;
      }
      if (s.status.code === 'error') errors++;
      const q = attrString(s, ATTR.JOIN_QUALITY);
      if (q) joinQuality[q] = (joinQuality[q] ?? 0) + 1;
    }
    return { input, output, errors, joinQuality };
  }, [spans]);

  // Prefer the server-side joinQuality stats; fall back to counting locally.
  const joinQualityStats =
    summary && Object.keys(summary.joinQualityStats).length > 0
      ? summary.joinQualityStats
      : stats.joinQuality;

  /** Select + scroll to + flash a span (search highlight, link jumps). */
  const jumpToSpan = useCallback(
    (spanId: string) => {
      if (!spansById.has(spanId)) return;
      setSelectedSpanId(spanId);
      setFlashSpanId(spanId);
      // 折叠的大 session 里目标可能不可见:强制展开目标的祖先链
      const chain = new Set<string>();
      let cur = spansById.get(spanId);
      while (cur !== undefined) {
        chain.add(cur.spanId);
        cur = cur.parentSpanId !== undefined ? spansById.get(cur.parentSpanId) : undefined;
      }
      setForceExpandedIds((prev) => {
        const next = new Set(prev);
        for (const id of chain) next.add(id);
        return next;
      });
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashSpanId(null), 1700);
      // Defer so the row is (re)rendered before scrolling.
      requestAnimationFrame(() => {
        document.getElementById(`span-${spanId}`)?.scrollIntoView({ block: 'center' });
      });
    },
    [spansById],
  );

  // Apply the ?span= highlight once spans are loaded (tree renders expanded
  // by default, so no ancestor expansion is needed).
  useEffect(() => {
    if (highlightSpanId && spans.length > 0) jumpToSpan(highlightSpanId);
  }, [highlightSpanId, spans, jumpToSpan]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  // Draggable divider: moving left widens the panel.
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const onDividerPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      dragState.current = { startX: e.clientX, startWidth: panelWidth };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [panelWidth],
  );
  const onDividerPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragState.current;
    if (!d) return;
    const next = d.startWidth + (d.startX - e.clientX);
    setPanelWidth(Math.min(900, Math.max(300, next)));
  }, []);
  const onDividerPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragState.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const selectedSpan = selectedSpanId ? spansById.get(selectedSpanId) : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div
        style={{
          padding: 'var(--spacing-4) var(--spacing-6)',
          borderBottom: '1px solid var(--color-border-default)',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 'var(--spacing-3)',
            flexWrap: 'wrap',
            marginBottom: 'var(--spacing-3)',
          }}
        >
          <button
            type="button"
            className="btn"
            onClick={() => {
              // 返回离开时的同步 URL(过滤状态不丢);直接打开详情页则回列表
              let last = '/sessions';
              try {
                last = sessionStorage.getItem(LAST_URL_KEY) ?? '/sessions';
              } catch {
                /* private mode */
              }
              navigate(last);
            }}
            style={{ alignSelf: 'center' }}
          >
            ← sessions
          </button>
          <h1 style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-fg-strong)', margin: 0 }}>
            Session
          </h1>
          <code
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--color-fg-faint)',
              wordBreak: 'break-all',
            }}
          >
            {sessionId}
          </code>
          {summary?.source ? (
            <span className={`src-badge ${srcBadgeClass(summary.source) ?? ''}`}>
              {summary.source}
            </span>
          ) : null}
          {summary?.startedAtMs !== undefined ? (
            <span style={{ fontSize: 12, color: 'var(--color-fg-muted)', fontFamily: 'var(--font-mono)' }}>
              {fmtTime(summary.startedAtMs)}
            </span>
          ) : null}
          {summary?.cwd ? (
            <span
              style={{
                fontSize: 11,
                color: 'var(--color-fg-faint)',
                fontFamily: 'var(--font-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 420,
              }}
              title={summary.cwd}
            >
              {summary.cwd}
            </span>
          ) : null}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
            gap: 'var(--spacing-3)',
          }}
        >
          <StatCard
            label="Duration"
            value={spans.length > 0 ? fmtMs(window_.duration) : '—'}
            sub={summary ? `${summary.turnCount} turns · ${summary.agentCount} agents` : undefined}
          />
          <StatCard label="Spans" value={String(spans.length)} sub={`${linkedIds.size} linked`} />
          <StatCard
            label="Tokens"
            value={fmtTokens((summary?.totalInputTokens ?? stats.input) + (summary?.totalOutputTokens ?? stats.output))}
            sub={`↑${fmtTokens(summary?.totalInputTokens ?? stats.input)} ↓${fmtTokens(summary?.totalOutputTokens ?? stats.output)}`}
          />
          <StatCard label="Cost" value={fmtCost(summary?.totalCostUsd ?? 0)} />
          <StatCard
            label="Errors"
            value={String(summary?.errorCount ?? stats.errors)}
            accent={
              (summary?.errorCount ?? stats.errors) > 0 ? 'var(--color-status-error)' : undefined
            }
          />
          <StatCard
            label="Build"
            value={
              summary?.buildStatus === 'pass'
                ? '✓ 通过'
                : summary?.buildStatus === 'fail'
                  ? '✗ 失败'
                  : '— 未运行'
            }
            sub="检测到测试/构建命令"
            tone={
              summary?.buildStatus === 'pass'
                ? 'var(--color-status-ok)'
                : summary?.buildStatus === 'fail'
                  ? 'var(--color-status-error)'
                  : undefined
            }
          />
        </div>

        {/* joinQuality distribution */}
        {Object.keys(joinQualityStats).length > 0 ? (
          <div
            style={{
              display: 'flex',
              gap: 6,
              marginTop: 'var(--spacing-3)',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: 'var(--color-fg-faint)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              joinQuality
            </span>
            {Object.entries(joinQualityStats)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([q, n]) => (
                <span
                  key={q}
                  style={{
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    padding: '1px 6px',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor:
                      q === 'heuristic'
                        ? 'color-mix(in srgb, var(--color-kind-pipeline) 18%, transparent)'
                        : 'var(--color-bg-hover)',
                    color: q === 'heuristic' ? 'var(--color-kind-pipeline)' : 'var(--color-fg-muted)',
                  }}
                >
                  {q}: {n}
                </span>
              ))}
          </div>
        ) : null}
      </div>

      {/* Body: tree | divider | panel */}
      {error ? (
        <div
          style={{
            padding: 'var(--spacing-8)',
            textAlign: 'center',
            color: 'var(--color-status-error)',
            fontSize: 13,
          }}
        >
          加载失败:{error}
        </div>
      ) : spansData === null ? (
        <div style={{ padding: 'var(--spacing-8)', textAlign: 'center', color: 'var(--color-fg-faint)', fontSize: 13 }}>
          加载中…
        </div>
      ) : (
        <div className="detail-body">
          <div className="tree-pane">
            {spans.length === 0 ? (
              <div style={{ padding: 'var(--spacing-8)', textAlign: 'center', color: 'var(--color-fg-faint)', fontSize: 13 }}>
                这个 session 没有 span。
              </div>
            ) : (
              <SpanTree
                spans={spans}
                selectedSpanId={selectedSpanId}
                onSelectSpan={setSelectedSpanId}
                maxDurationMs={maxDurationMs}
                linkedIds={linkedIds}
                flashSpanId={flashSpanId}
                forceExpandedIds={forceExpandedIds}
              />
            )}
          </div>
          <div
            className="split-divider"
            onPointerDown={onDividerPointerDown}
            onPointerMove={onDividerPointerMove}
            onPointerUp={onDividerPointerUp}
          />
          <div className="panel-pane" style={{ width: panelWidth }}>
            {selectedSpan ? (
              <div className="card" style={{ padding: 'var(--spacing-3)' }}>
                <SpanDetail
                  span={selectedSpan}
                  links={links}
                  spansById={spansById}
                  onJumpToSpan={jumpToSpan}
                  onClose={() => setSelectedSpanId(null)}
                />
              </div>
            ) : (
              <div
                className="card"
                style={{
                  padding: 'var(--spacing-8)',
                  textAlign: 'center',
                  color: 'var(--color-fg-faint)',
                  fontSize: 12,
                }}
              >
                点击左侧树节点查看 span 详情
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 平台徽章配色类(详情页头部)。 */
function srcBadgeClass(source: string): string | undefined {
  if (source === 'claude-code') return 'src-cc';
  if (source === 'kimi-code') return 'src-kimi';
  if (source === 'codex') return 'src-codex';
  return undefined;
}
