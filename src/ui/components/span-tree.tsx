/**
 * SpanTree — ported from agent-flow/apps/trace-ui/components/span-tree.tsx
 * (same author) and adapted to the tya data model:
 *
 *   - recursive indented tree, fully expanded by default, chevron collapses
 *     a subtree without selecting the node
 *   - per-kind badge colors (lib/colors.ts), LLM token counts and TOOL
 *     input→output summaries inline
 *   - duration shown as text + a bar whose width is relative to the longest
 *     span in the session
 *   - tya-specific markers (src/core/types.ts ATTR keys):
 *       attributes.detached === true        → ⏚ badge + dashed row outline
 *       attributes.incomplete === true      → ⚠ badge
 *       attributes.approx === true          → duration prefixed with ~
 *       attributes.joinQuality === 'heuristic' → dashed left mounting edge
 *   - spans taking part in a Link get a ⇄ badge
 *   - rows carry id={`span-<spanId>`} so the page can scrollIntoView them;
 *     flashSpanId plays a one-shot highlight animation
 *
 * 性能(大 session 优化):
 *   1. 建树索引一次完成:childrenBy Map(parent → sorted children)按 spans
 *      引用 useMemo,取子代 O(1)——不再每节点 O(n) filter(原 O(n²))。
 *   2. "廉价容器 + memo 叶子":TreeNode(仅递归与折叠,几乎无成本)照常
 *      下传 selectedSpanId;真正贵的行 DOM 由 memo 化的 SpanRow 渲染,
 *      选中/闪烁以 isSelected/flash 布尔传入——一次点击只有新旧两行做
 *      真实重渲染,其余行只是浅层函数调用。
 */
import { memo, useCallback, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import {
  ATTR,
  attrString,
  isApprox,
  isDetached,
  isHeuristicJoin,
  isIncomplete,
  isSpawnSpan,
} from '../lib/types.js';
import type { Span } from '../lib/types.js';
import { kindColorHex, theme } from '../lib/colors.js';
import { fmtCost, fmtMs, fmtTokens } from '../lib/format.js';
import { estimateCostUsd } from '../../store/pricing.js';

interface SpanTreeProps {
  spans: Span[];
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string) => void;
  /** Width reference for the duration bars (longest span in the session). */
  maxDurationMs: number;
  /** Span ids taking part in at least one Link. */
  linkedIds: ReadonlySet<string>;
  flashSpanId: string | null;
  /** 强制展开的节点(搜索跳转目标的祖先链;折叠的大 session 也能定位)。 */
  forceExpandedIds: ReadonlySet<string>;
}

/** 超过该 span 数时默认折叠到 turn 级(大 session 的 DOM 兜底)。 */
export const COLLAPSE_TO_TURN_THRESHOLD = 2000;

/** O(n) 一次构建:parent → 按开始时间排序的子代数组;同时算出 roots。 */
function buildTreeIndex(spans: readonly Span[]): {
  roots: Span[];
  childrenBy: ReadonlyMap<string, Span[]>;
} {
  const idSet = new Set(spans.map((s) => s.spanId));
  const childrenBy = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const s of spans) {
    const parent = s.parentSpanId;
    if (parent === undefined || !idSet.has(parent)) {
      roots.push(s);
      continue;
    }
    const kids = childrenBy.get(parent);
    if (kids === undefined) childrenBy.set(parent, [s]);
    else kids.push(s);
  }
  roots.sort((a, b) => a.startTimeMs - b.startTimeMs);
  for (const kids of childrenBy.values()) {
    kids.sort((a, b) => a.startTimeMs - b.startTimeMs);
  }
  if (roots.length === 0 && spans.length > 0) {
    roots.push(spans.reduce((a, b) => (a.startTimeMs < b.startTimeMs ? a : b)));
  }
  return { roots, childrenBy };
}

/**
 * 每个节点的子树 cost 汇总(含自身)。只有当子树内存在可计价的 LLM_CALL
 * 时才会有值;全空(模型未登记 / 无 token)则不入 map,行上不渲染。
 */
function computeSubtreeCosts(
  roots: readonly Span[],
  childrenBy: ReadonlyMap<string, Span[]>,
): ReadonlyMap<string, number> {
  const costs = new Map<string, number>();
  const visit = (span: Span): number => {
    let sum = 0;
    const model = attrString(span, ATTR.GEN_AI_MODEL);
    if (span.tokenUsage !== undefined && model !== undefined) {
      const c = estimateCostUsd(span.tokenUsage, model);
      if (c !== undefined) sum += c;
    }
    for (const k of childrenBy.get(span.spanId) ?? []) sum += visit(k);
    if (sum > 0) costs.set(span.spanId, sum);
    return sum;
  };
  for (const r of roots) visit(r);
  return costs;
}

export function SpanTree({
  spans,
  selectedSpanId,
  onSelectSpan,
  maxDurationMs,
  linkedIds,
  flashSpanId,
  forceExpandedIds,
}: SpanTreeProps) {
  const { roots, childrenBy } = useMemo(() => buildTreeIndex(spans), [spans]);
  const subtreeCosts = useMemo(
    () => computeSubtreeCosts(roots, childrenBy),
    [roots, childrenBy],
  );
  // 大 session:turn 级默认收起,DOM 从 N 降到 turn 数;小 session 全展开
  const collapseToTurn = spans.length > COLLAPSE_TO_TURN_THRESHOLD;

  return (
    <div
      className="card"
      style={{ padding: 'var(--spacing-2)', minHeight: 0 }}
    >
      {roots.map((r) => (
        <TreeNode
          key={r.spanId}
          span={r}
          childrenBy={childrenBy}
          subtreeCosts={subtreeCosts}
          depth={0}
          selectedSpanId={selectedSpanId}
          flashSpanId={flashSpanId}
          onSelectSpan={onSelectSpan}
          maxDurationMs={maxDurationMs}
          linkedIds={linkedIds}
          collapseToTurn={collapseToTurn}
          forceExpandedIds={forceExpandedIds}
        />
      ))}
    </div>
  );
}

interface TreeNodeProps {
  span: Span;
  childrenBy: ReadonlyMap<string, Span[]>;
  subtreeCosts: ReadonlyMap<string, number>;
  depth: number;
  selectedSpanId: string | null;
  flashSpanId: string | null;
  onSelectSpan: (spanId: string) => void;
  maxDurationMs: number;
  linkedIds: ReadonlySet<string>;
  collapseToTurn: boolean;
  forceExpandedIds: ReadonlySet<string>;
}

/** 容器:折叠状态 + 递归。不 memo——函数体极廉,memo 叶子才划算。 */
function TreeNode({
  span,
  childrenBy,
  subtreeCosts,
  depth,
  selectedSpanId,
  flashSpanId,
  onSelectSpan,
  maxDurationMs,
  linkedIds,
  collapseToTurn,
  forceExpandedIds,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(
    () => !(collapseToTurn && span.kind === 'AGENT_TURN'),
  );
  const kids = childrenBy.get(span.spanId) ?? [];
  const hasChildren = kids.length > 0;
  // 搜索跳转的祖先链强制展开(优先级高于本地折叠)
  const isOpen = expanded || forceExpandedIds.has(span.spanId);

  const toggle = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setExpanded((v) => !v);
  }, []);

  return (
    <div>
      <SpanRow
        span={span}
        depth={depth}
        hasChildren={hasChildren}
        expanded={isOpen}
        onToggle={toggle}
        isSelected={selectedSpanId === span.spanId}
        flash={flashSpanId === span.spanId}
        onSelectSpan={onSelectSpan}
        maxDurationMs={maxDurationMs}
        linked={linkedIds.has(span.spanId)}
        subtreeCost={subtreeCosts.get(span.spanId)}
      />
      {hasChildren && isOpen
        ? kids.map((c) => (
            <TreeNode
              key={c.spanId}
              span={c}
              childrenBy={childrenBy}
              subtreeCosts={subtreeCosts}
              depth={depth + 1}
              selectedSpanId={selectedSpanId}
              flashSpanId={flashSpanId}
              onSelectSpan={onSelectSpan}
              maxDurationMs={maxDurationMs}
              linkedIds={linkedIds}
              collapseToTurn={collapseToTurn}
              forceExpandedIds={forceExpandedIds}
            />
          ))
        : null}
    </div>
  );
}

interface SpanRowProps {
  span: Span;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  onToggle: (e: MouseEvent) => void;
  isSelected: boolean;
  flash: boolean;
  onSelectSpan: (spanId: string) => void;
  maxDurationMs: number;
  linked: boolean;
  /** 子树(含自身)的 cost 汇总;仅 AGENT_TURN 行渲染。 */
  subtreeCost?: number;
}

/** 叶子:真实的行 DOM。memo 后一次点击只有新旧两行重渲染。 */
const SpanRow = memo(function SpanRow({
  span,
  depth,
  hasChildren,
  expanded,
  onToggle,
  isSelected,
  flash,
  onSelectSpan,
  maxDurationMs,
  linked,
  subtreeCost,
}: SpanRowProps) {
  const isError = span.status.code === 'error';
  const color = kindColorHex(span.kind);
  const detached = isDetached(span);
  const incomplete = isIncomplete(span);
  const approx = isApprox(span);
  const heuristic = isHeuristicJoin(span);
  const spawn = isSpawnSpan(span);

  // Border composition, by precedence:
  //   selected > detached (dashed outline) > plain; heuristic always wins on
  //   the left edge (it marks the mounting edge to the parent).
  let border: string;
  if (isSelected) {
    border = '1px solid color-mix(in srgb, var(--color-kind-agent) 50%, transparent)';
  } else if (detached) {
    border = '1px dashed var(--color-border-light)';
  } else {
    border = '1px solid transparent';
  }
  const borderLeft = heuristic
    ? `2px dashed ${theme.heuristic}`
    : isSelected
      ? border
      : detached
        ? '1px dashed var(--color-border-light)'
        : '1px solid transparent';

  const barPct = Math.max(2, Math.min(100, (span.durationMs / Math.max(maxDurationMs, 1)) * 100));

  return (
    <div
      id={`span-${span.spanId}`}
      className={`span-row${flash ? ' span-flash' : ''}`}
      onClick={() => onSelectSpan(span.spanId)}
      title={
        heuristic
          ? 'joinQuality=heuristic: parent attachment guessed from timing/order'
          : undefined
      }
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingLeft: 6 + depth * 16,
        paddingRight: 8,
        height: 26,
        cursor: 'pointer',
        backgroundColor: isSelected
          ? 'color-mix(in srgb, var(--color-kind-agent) 15%, transparent)'
          : 'transparent',
        border,
        borderLeft,
      }}
    >
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggle}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: 'var(--color-fg-faint)',
            fontSize: '10px',
            width: 14,
            display: 'flex',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▼' : '▶'}
        </button>
      ) : (
        <span style={{ width: 14, flexShrink: 0 }} />
      )}

      {/* tya markers: spawn / detached / incomplete */}
      {spawn ? (
        <span
          title="Spawns child agent"
          style={{ color: 'var(--color-kind-a2a)', flexShrink: 0, fontWeight: 700, fontSize: '11px' }}
        >
          ↳
        </span>
      ) : null}
      {detached ? (
        <span
          title="detached: background subagent span tree"
          style={{ color: 'var(--color-fg-muted)', flexShrink: 0, fontWeight: 700, fontSize: '11px' }}
        >
          ⏚
        </span>
      ) : null}
      {incomplete ? (
        <span
          title="incomplete: closed by end-of-file cleanup, not a real end event"
          style={{ color: theme.heuristic, flexShrink: 0, fontSize: '11px' }}
        >
          ⚠
        </span>
      ) : null}

      {/* Kind badge */}
      <span
        style={{
          fontSize: '9px',
          fontWeight: 600,
          padding: '1px 5px',
          borderRadius: 'var(--radius-sm)',
          backgroundColor: `${color}22`,
          color,
          flexShrink: 0,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {span.kind.replace('_CALL', '').replace('_TURN', '').slice(0, 6)}
      </span>

      {/* Name */}
      <span
        style={{
          fontSize: '12px',
          color: 'var(--color-fg-default)',
          fontFamily: 'var(--font-mono)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {span.name}
      </span>

      {/* Kind-specific extras */}
      {span.kind === 'LLM_CALL' && span.tokenUsage ? (
        <span
          style={{
            fontSize: '10px',
            color: 'var(--color-fg-faint)',
            fontFamily: 'var(--font-mono)',
            flexShrink: 0,
          }}
        >
          ↑{fmtTokens(span.tokenUsage.inputTokens)} ↓{fmtTokens(span.tokenUsage.outputTokens)}
        </span>
      ) : null}
      {span.kind === 'AGENT_TURN' && subtreeCost !== undefined ? (
        <span
          style={{
            fontSize: '10px',
            color: 'var(--color-fg-faint)',
            fontFamily: 'var(--font-mono)',
            flexShrink: 0,
          }}
        >
          {fmtCost(subtreeCost)}
        </span>
      ) : null}
      {span.kind === 'TOOL_CALL' ? (
        <span
          style={{
            fontSize: '10px',
            color: 'var(--color-fg-faint)',
            fontFamily: 'var(--font-mono)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 1,
            minWidth: 0,
          }}
          title={`${span.inputSummary ?? ''} → ${span.outputSummary ?? ''}`}
        >
          {truncate(span.inputSummary, 24)}
          <span style={{ color: 'var(--color-fg-faint)', margin: '0 4px' }}>→</span>
          {truncate(span.outputSummary, 24)}
        </span>
      ) : null}

      {/* Link participation */}
      {linked ? (
        <span
          title="takes part in a link (NOTIFY/MESSAGE) — see detail panel"
          style={{ color: 'var(--color-kind-llm)', flexShrink: 0, fontSize: '10px' }}
        >
          ⇄
        </span>
      ) : null}

      {/* Duration: relative-width bar + text */}
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
          marginLeft: 'auto',
        }}
      >
        <span
          style={{
            width: 56,
            height: 4,
            borderRadius: 2,
            backgroundColor: 'var(--color-border-default)',
            overflow: 'hidden',
            display: 'inline-block',
          }}
        >
          <span
            style={{
              display: 'block',
              height: '100%',
              width: `${barPct}%`,
              backgroundColor: color,
              opacity: 0.85,
            }}
          />
        </span>
        <span
          style={{
            fontSize: '10px',
            color: 'var(--color-fg-muted)',
            fontFamily: 'var(--font-mono)',
          }}
          title={approx ? 'duration inferred (approx)' : undefined}
        >
          {approx ? '~' : ''}
          {fmtMs(span.durationMs)}
        </span>
      </span>

      {/* Status */}
      <span
        style={{
          fontSize: '9px',
          padding: '1px 4px',
          borderRadius: 2,
          backgroundColor: isError ? `${theme.status.error}22` : `${theme.status.ok}22`,
          color: isError ? theme.status.error : theme.status.ok,
          flexShrink: 0,
        }}
      >
        {isError ? 'err' : 'ok'}
      </span>
    </div>
  );
});

function truncate(s: string | undefined, max: number): string {
  if (!s) return '';
  const flat = s.replace(/\n/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
