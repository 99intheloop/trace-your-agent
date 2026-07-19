/**
 * SpanKind → color mapping, ported from agent-flow/apps/trace-ui/lib/colors.ts
 * (same author), trimmed to the four kinds of the tya span model.
 *
 * Deviation from trace-ui: SESSION is slate gray instead of violet, per the
 * UI spec (LLM_CALL 蓝 / TOOL_CALL 绿 / AGENT_TURN 紫 / SESSION 灰).
 */
import type { SpanKind } from './types.js';

/** CSS var() reference, for inline styles. */
export function kindColor(kind: SpanKind | string): string {
  switch (kind) {
    case 'LLM_CALL':
      return 'var(--color-kind-llm)';
    case 'TOOL_CALL':
      return 'var(--color-kind-tool)';
    case 'AGENT_TURN':
      return 'var(--color-kind-agent)';
    case 'SESSION':
      return 'var(--color-kind-session)';
    default:
      return 'var(--color-fg-faint)';
  }
}

/** Hex value, for contexts that cannot consume CSS var(). */
export function kindColorHex(kind: SpanKind | string): string {
  switch (kind) {
    case 'LLM_CALL':
      return '#3b82f6';
    case 'TOOL_CALL':
      return '#22c55e';
    case 'AGENT_TURN':
      return '#6366f1';
    case 'SESSION':
      return '#64748b';
    default:
      return '#64748b';
  }
}

/** Theme constants mirroring styles.css, for color-mix() composition. */
export const theme = {
  status: {
    ok: '#22c55e',
    error: '#ef4444',
  },
  heuristic: '#f59e0b',
} as const;
