/**
 * SpanDetail — right-hand panel for the selected span. Layout conventions
 * ported from agent-flow/apps/trace-ui/components/span-detail-drawer.tsx
 * (same author), rendered as a docked panel instead of a Radix drawer.
 *
 * Sections: header (kind/name/status) · meta grid · links (NOTIFY/MESSAGE,
 * click jumps + scrolls to the other end) · tokenUsage · input/output
 * summaries (mono, clamped, expandable) · events timeline · full attributes
 * table · payloadRef loader (GET /api/payloads/:ref, JSON tree / raw toggle).
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../lib/api.js';
import { kindColorHex, theme } from '../lib/colors.js';
import { fmtMs, fmtTime, fmtTokens } from '../lib/format.js';
import { ATTR, attrString } from '../lib/types.js';
import type { Link, Span } from '../lib/types.js';

interface SpanDetailProps {
  span: Span;
  links: Link[];
  spansById: ReadonlyMap<string, Span>;
  onJumpToSpan: (spanId: string) => void;
  onClose: () => void;
}

export function SpanDetail({ span, links, spansById, onJumpToSpan, onClose }: SpanDetailProps) {
  const isError = span.status.code === 'error';
  const color = kindColorHex(span.kind);
  const model = attrString(span, ATTR.GEN_AI_MODEL);
  const incoming = links.filter((l) => l.toSpanId === span.spanId);
  const outgoing = links.filter((l) => l.fromSpanId === span.spanId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
      {/* Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: '9px',
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: `${color}22`,
              color,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {span.kind}
          </span>
          <span
            style={{
              fontSize: '9px',
              padding: '2px 6px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: isError ? `${theme.status.error}22` : `${theme.status.ok}22`,
              color: isError ? theme.status.error : theme.status.ok,
            }}
          >
            {isError ? 'error' : 'ok'}
          </span>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            aria-label="Close"
            style={{ marginLeft: 'auto', padding: '1px 8px' }}
          >
            ×
          </button>
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: '13px',
            fontWeight: 600,
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-fg-strong)',
            wordBreak: 'break-all',
          }}
        >
          {span.name}
        </div>
        {isError && span.status.message ? (
          <div
            style={{
              marginTop: 4,
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
              color: theme.status.error,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {span.status.message}
          </div>
        ) : null}
      </div>

      {/* Meta grid */}
      <Section title="Meta">
        <KvTable
          rows={[
            ['spanId', span.spanId],
            ['traceId', span.traceId],
            ['start', fmtTime(span.startTimeMs)],
            ['duration', fmtMs(span.durationMs)],
            ['agent', span.agentName],
            ['tool', span.toolName],
            ['model', model],
          ]}
        />
        {span.parentSpanId ? (
          <div style={{ marginTop: 6, fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
            <span style={{ color: 'var(--color-fg-faint)' }}>parent </span>
            <JumpLink spanId={span.parentSpanId} spansById={spansById} onJump={onJumpToSpan} />
          </div>
        ) : null}
      </Section>

      {/* Links (NOTIFY / MESSAGE) */}
      {incoming.length > 0 || outgoing.length > 0 ? (
        <Section title={`Links (${incoming.length + outgoing.length})`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {incoming.map((l, i) => (
              <LinkRow key={`in-${i}`} dir="in" link={l} spansById={spansById} onJump={onJumpToSpan} />
            ))}
            {outgoing.map((l, i) => (
              <LinkRow key={`out-${i}`} dir="out" link={l} spansById={spansById} onJump={onJumpToSpan} />
            ))}
          </div>
        </Section>
      ) : null}

      {/* Token usage */}
      {span.tokenUsage ? (
        <Section title="Token Usage">
          <KvTable
            rows={[
              ['input', fmtTokens(span.tokenUsage.inputTokens)],
              ['output', fmtTokens(span.tokenUsage.outputTokens)],
              [
                'cache read',
                span.tokenUsage.cacheReadTokens !== undefined
                  ? fmtTokens(span.tokenUsage.cacheReadTokens)
                  : undefined,
              ],
              [
                'cache write',
                span.tokenUsage.cacheWriteTokens !== undefined
                  ? fmtTokens(span.tokenUsage.cacheWriteTokens)
                  : undefined,
              ],
            ]}
          />
        </Section>
      ) : null}

      {/* Input / output summaries */}
      {span.inputSummary ? (
        <Section title="Input Summary">
          <ClampedPre text={span.inputSummary} />
        </Section>
      ) : null}
      {span.outputSummary ? (
        <Section title="Output Summary">
          <ClampedPre text={span.outputSummary} />
        </Section>
      ) : null}

      {/* Events */}
      {span.events && span.events.length > 0 ? (
        <Section title={`Events (${span.events.length})`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {span.events.map((ev, i) => (
              <div key={i} style={{ fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: 'var(--color-fg-faint)', flexShrink: 0 }}>
                    +{fmtMs(Math.max(0, ev.timestampMs - span.startTimeMs))}
                  </span>
                  <span style={{ color: 'var(--color-fg-default)' }}>{ev.name}</span>
                </div>
                {ev.attributes && Object.keys(ev.attributes).length > 0 ? (
                  <div
                    style={{
                      color: 'var(--color-fg-faint)',
                      paddingLeft: 14,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {Object.entries(ev.attributes)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join('  ')}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {/* All attributes */}
      <Section title={`Attributes (${Object.keys(span.attributes).length})`}>
        <KvTable
          rows={Object.entries(span.attributes)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, String(v)] as const)}
        />
      </Section>

      {/* Payload store reference */}
      {span.payloadRef ? (
        <Section title="Payload">
          <PayloadLoader payloadRef={span.payloadRef} />
        </Section>
      ) : null}
    </div>
  );
}

// ─── Building blocks ────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: '10px',
          fontWeight: 600,
          color: 'var(--color-fg-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: 6,
          borderBottom: '1px solid var(--color-border-default)',
          paddingBottom: 4,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function KvTable({ rows }: { rows: ReadonlyArray<readonly [string, string | undefined | null]> }) {
  const present = rows.filter((r): r is readonly [string, string] => r[1] != null && r[1] !== '');
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
      <tbody>
        {present.map(([k, v]) => (
          <tr key={k}>
            <td
              style={{
                color: 'var(--color-fg-faint)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                padding: '2px 8px 2px 0',
                verticalAlign: 'top',
                whiteSpace: 'nowrap',
              }}
            >
              {k}
            </td>
            <td
              style={{
                color: 'var(--color-fg-default)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                padding: '2px 0',
                wordBreak: 'break-all',
              }}
            >
              {v}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function JumpLink({
  spanId,
  spansById,
  onJump,
}: {
  spanId: string;
  spansById: ReadonlyMap<string, Span>;
  onJump: (spanId: string) => void;
}) {
  const target = spansById.get(spanId);
  return (
    <button
      type="button"
      className="btn"
      onClick={() => onJump(spanId)}
      title={target ? `jump to ${target.name}` : `jump to ${spanId}`}
      style={{ padding: '1px 6px', fontSize: '10px' }}
    >
      {target ? target.name : spanId.slice(0, 12)}
    </button>
  );
}

function LinkRow({
  dir,
  link,
  spansById,
  onJump,
}: {
  dir: 'in' | 'out';
  link: Link;
  spansById: ReadonlyMap<string, Span>;
  onJump: (spanId: string) => void;
}) {
  const otherId = dir === 'in' ? link.fromSpanId : link.toSpanId;
  const kindColor = link.kind === 'NOTIFY' ? theme.heuristic : '#3b82f6';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: '11px',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <span
        style={{
          fontSize: '9px',
          fontWeight: 600,
          padding: '1px 5px',
          borderRadius: 'var(--radius-sm)',
          backgroundColor: `${kindColor}22`,
          color: kindColor,
          flexShrink: 0,
        }}
      >
        {link.kind}
      </span>
      <span style={{ color: 'var(--color-fg-faint)', flexShrink: 0 }}>
        {dir === 'in' ? '← from' : '→ to'}
      </span>
      <JumpLink spanId={otherId} spansById={spansById} onJump={onJump} />
    </div>
  );
}

/** Mono block clamped to 4 lines with an expand/collapse toggle. */
function ClampedPre({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <pre
        className={expanded ? undefined : 'clamp'}
        style={{
          margin: 0,
          padding: 'var(--spacing-2)',
          backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border-default)',
          borderRadius: 'var(--radius-md)',
          fontSize: '11px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-fg-default)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowX: 'auto',
        }}
      >
        {text}
      </pre>
      <button
        type="button"
        className="btn"
        onClick={() => setExpanded((v) => !v)}
        style={{ marginTop: 4, fontSize: '10px', padding: '1px 8px' }}
      >
        {expanded ? 'collapse' : 'expand'}
      </button>
    </div>
  );
}

function PayloadLoader({ payloadRef }: { payloadRef: string }) {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'loaded'; data: unknown }
  >({ status: 'idle' });
  const [raw, setRaw] = useState(false);

  // Reset when a different span (different ref) is shown.
  useEffect(() => {
    setState({ status: 'idle' });
    setRaw(false);
  }, [payloadRef]);

  function load() {
    setState({ status: 'loading' });
    api
      .payload(payloadRef)
      .then((data) => setState({ status: 'loaded', data }))
      .catch((e: unknown) =>
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
      );
  }

  return (
    <div>
      <div
        style={{
          fontSize: '10px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-fg-faint)',
          marginBottom: 6,
          wordBreak: 'break-all',
        }}
      >
        ref: {payloadRef}
      </div>
      {state.status === 'idle' || state.status === 'loading' ? (
        <button
          type="button"
          className="btn"
          disabled={state.status === 'loading'}
          onClick={load}
        >
          {state.status === 'loading' ? 'loading…' : 'load payload'}
        </button>
      ) : null}
      {state.status === 'error' ? (
        <div style={{ fontSize: '11px', color: theme.status.error, fontFamily: 'var(--font-mono)' }}>
          {state.message}{' '}
          <button type="button" className="btn" onClick={load} style={{ fontSize: '10px' }}>
            retry
          </button>
        </div>
      ) : null}
      {state.status === 'loaded' ? (
        <div>
          <button
            type="button"
            className="btn"
            onClick={() => setRaw((v) => !v)}
            style={{ fontSize: '10px', padding: '1px 8px', marginBottom: 4 }}
          >
            {raw ? 'tree view' : 'raw view'}
          </button>
          {raw ? (
            <pre
              style={{
                margin: 0,
                padding: 'var(--spacing-2)',
                backgroundColor: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-md)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-fg-default)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 400,
                overflow: 'auto',
              }}
            >
              {JSON.stringify(state.data, null, 2)}
            </pre>
          ) : (
            <div
              style={{
                padding: 'var(--spacing-2)',
                backgroundColor: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-md)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                maxHeight: 400,
                overflow: 'auto',
              }}
            >
              <JsonNode value={state.data} depth={0} />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Collapsible JSON tree for arbitrary payload data. */
function JsonNode({ value, depth, label }: { value: unknown; depth: number; label?: string | undefined }) {
  const [open, setOpen] = useState(depth < 2);
  const indent = depth * 14;

  if (value === null) return <JsonLeaf label={label} rendered={<span className="json-null">null</span>} indent={indent} />;
  if (typeof value === 'string')
    return <JsonLeaf label={label} rendered={<span className="json-string">&quot;{value}&quot;</span>} indent={indent} />;
  if (typeof value === 'number')
    return <JsonLeaf label={label} rendered={<span className="json-number">{String(value)}</span>} indent={indent} />;
  if (typeof value === 'boolean')
    return <JsonLeaf label={label} rendered={<span className="json-bool">{String(value)}</span>} indent={indent} />;

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);
  const openBracket = Array.isArray(value) ? '[' : '{';
  const closeBracket = Array.isArray(value) ? ']' : '}';

  return (
    <div>
      <div style={{ paddingLeft: indent, whiteSpace: 'nowrap' }}>
        <button type="button" className="json-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? '▾' : '▸'}
        </button>
        {label !== undefined ? <span className="json-key">{label}: </span> : null}
        <span className="json-null">
          {openBracket}
          {!open ? ` … ${entries.length} ${closeBracket}` : ''}
        </span>
      </div>
      {open ? (
        <div>
          {entries.map(([k, v]) => (
            <JsonNode key={k} value={v} depth={depth + 1} label={k} />
          ))}
          <div style={{ paddingLeft: indent }} className="json-null">
            {closeBracket}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function JsonLeaf({
  label,
  rendered,
  indent,
}: {
  label: string | undefined;
  rendered: ReactNode;
  indent: number;
}) {
  return (
    <div style={{ paddingLeft: indent + 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {label !== undefined ? <span className="json-key">{label}: </span> : null}
      {rendered}
    </div>
  );
}
