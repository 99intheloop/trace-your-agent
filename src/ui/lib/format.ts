/**
 * Pure formatting helpers. No I/O, no side effects.
 * Ported verbatim from agent-flow/apps/trace-ui/lib/format.ts (same author),
 * except fmtMs rounds sub-second values for display.
 */

/** Format a millisecond duration compactly: 840ms / 1.2s / 3.5m. */
export function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** Format a token count: 840 / 12.3K / 4.5M. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format a USD cost: — / $0.234m / $0.0123. */
export function fmtCost(usd: number): string {
  if (usd === 0) return '—';
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Format an epoch-ms timestamp for display.
 * Returns YYYY-MM-DD HH:MM:SS in local time.
 */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Relative time from now: "3m ago" / "2h ago" / "just now". */
export function fmtRelative(ms: number, nowMs = Date.now()): string {
  const diff = nowMs - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
