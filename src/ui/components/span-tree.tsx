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
 *     (trace-ui's subagent/agent.task rendering has no tya counterpart and
 *      was dropped; the ↳ spawn marker is kept via agent.spawn.childAgentId)
 *   - spans taking part in a Link get a ⇄ badge
 *   - rows carry id={`span-<spanId>`} so the page can scrollIntoView them;
 *     flashSpanId plays a one-shot highlight animation
 */
import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';
import {
  isApprox,
  isDetached,
  isHeuristicJoin,
  isIncomplete,
  isSpawnSpan,
} from '../lib/types.js';
import type { Span } from '../lib/types.js';
import { childrenOf } from '../lib/tree.js';
import { kindColorHex, theme } from '../lib/colors.js';
import { fmtMs, fmtTokens } from '../lib/format.js';

interface SpanTreeProps {
  spans: Span[];
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string) => void;
  /** Width reference for the duration bars (longest span in the session). */
  maxDurationMs: number;
  /** Span ids taking part in at least one Link. */
  linkedIds: ReadonlySet<string>;
  flashSpanId: string | null;
}

export function SpanTree({
  spans,
  selectedSpanId,
  onSelectSpan,
  maxDurationMs,
  linkedIds,
  flashSpanId,
}: SpanTreeProps) {
  // Roots: no parentSpanId, or parentSpanId not found in set.
  const idSet = new Set(spans.map((s) => s.spanId));
  let roots = spans.filter((s) => !s.parentSpanId || !idSet.has(s.parentSpanId));
  if (roots.length === 0) {
    roots = [spans.reduce((a, b) => (a.startTimeMs < b.startTimeMs ? a : b))];
  }
  roots.sort((a, b) => a.startTimeMs - b.startTimeMs);

  return (
    <div
      className="card"
      style={{ padding: 'var(--spacing-2)', minHeight: 0 }}
    >
      {roots.map((r) => (
        <TreeNode
          key={r.spanId}
          span={r}
          spans={spans}
          depth={0}
          selectedSpanId={selectedSpanId}
          onSelectSpan={onSelectSpan}
          maxDurationMs={maxDurationMs}
          linkedIds={linkedIds}
          flashSpanId={flashSpanId}
        />
      ))}
    </div>
  );
}

interface TreeNodeProps extends SpanTreeProps {
  span: Span;
  depth: number;
}

function TreeNode({
  span,
  spans,
  depth,
  selectedSpanId,
  onSelectSpan,
  maxDurationMs,
  linkedIds,
  flashSpanId,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const kids = childrenOf(span.spanId, spans);
  const hasChildren = kids.length > 0;
  const isSelected = selectedSpanId === span.spanId;
  const isError = span.status.code === 'error';
  const color = kindColorHex(span.kind);
  const detached = isDetached(span);
  const incomplete = isIncomplete(span);
  const approx = isApprox(span);
  const heuristic = isHeuristicJoin(span);
  const spawn = isSpawnSpan(span);
  const linked = linkedIds.has(span.spanId);

  const toggle = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setExpanded((v) => !v);
  }, []);

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
    <div>
      <div
        id={`span-${span.spanId}`}
        className={`span-row${flashSpanId === span.spanId ? ' span-flash' : ''}`}
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
            onClick={toggle}
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

      {hasChildren && expanded
        ? kids.map((c) => (
            <TreeNode
              key={c.spanId}
              span={c}
              spans={spans}
              depth={depth + 1}
              selectedSpanId={selectedSpanId}
              onSelectSpan={onSelectSpan}
              maxDurationMs={maxDurationMs}
              linkedIds={linkedIds}
              flashSpanId={flashSpanId}
            />
          ))
        : null}
    </div>
  );
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return '';
  const flat = s.replace(/\n/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
