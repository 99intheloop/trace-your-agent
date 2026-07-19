/**
 * StatCard — ported from agent-flow/apps/trace-ui/components/trace-header.tsx
 * (same author). Small aggregate card with an optional left accent bar.
 */
export function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  accent?: string | undefined;
}) {
  return (
    <div
      className="card"
      style={{ padding: 'var(--spacing-3) var(--spacing-4)', position: 'relative', overflow: 'hidden' }}
    >
      {accent ? (
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: '3px',
            backgroundColor: accent,
          }}
        />
      ) : null}
      <div
        style={{
          fontSize: '11px',
          color: 'var(--color-fg-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: '4px',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '22px',
          fontWeight: 600,
          color: 'var(--color-fg-strong)',
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {sub ? (
        <div
          style={{
            fontSize: '11px',
            color: 'var(--color-fg-faint)',
            marginTop: '4px',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  );
}
