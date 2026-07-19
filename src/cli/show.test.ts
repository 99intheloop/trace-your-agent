import { describe, expect, it } from 'vitest';
import { ATTR, type Span } from '../core/types.js';
import { renderSpanTree } from './show.js';

function span(overrides: Partial<Span> & Pick<Span, 'spanId' | 'kind' | 'name'>): Span {
  return {
    traceId: 't'.repeat(32),
    startTimeMs: 0,
    durationMs: 0,
    status: { code: 'ok' },
    attributes: {},
    ...overrides,
  };
}

const TREE: Span[] = [
  span({ spanId: 'root', kind: 'SESSION', name: 'session', startTimeMs: 0, durationMs: 9000 }),
  span({
    spanId: 'turn1',
    kind: 'AGENT_TURN',
    name: 'turn 1',
    parentSpanId: 'root',
    startTimeMs: 100,
    durationMs: 3000,
  }),
  span({
    spanId: 'llm1',
    kind: 'LLM_CALL',
    name: 'claude-sonnet',
    parentSpanId: 'turn1',
    startTimeMs: 200,
    durationMs: 1200,
    tokenUsage: { inputTokens: 120, outputTokens: 45 },
  }),
  span({
    spanId: 'tool1',
    kind: 'TOOL_CALL',
    name: 'Bash',
    parentSpanId: 'turn1',
    startTimeMs: 1500,
    durationMs: 800,
    attributes: { [ATTR.INCOMPLETE]: true },
  }),
  span({
    spanId: 'bg1',
    kind: 'AGENT_TURN',
    name: 'background agent',
    parentSpanId: 'root',
    startTimeMs: 4000,
    durationMs: 5000,
    attributes: { [ATTR.DETACHED]: true },
  }),
  // Orphan: parentSpanId points at a span that is not in the set.
  span({
    spanId: 'orphan1',
    kind: 'TOOL_CALL',
    name: 'lost tool',
    parentSpanId: 'missing-parent',
    startTimeMs: 6000,
    durationMs: 100,
    status: { code: 'error', message: 'boom' },
  }),
];

describe('renderSpanTree', () => {
  it('renders an indented tree with kind icons, durations and tokens', () => {
    const text = renderSpanTree(TREE);
    const lines = text.split('\n');
    expect(lines[0]).toContain('◆ session');
    expect(lines[0]).toContain('9.0s');
    expect(text).toContain('├── ● turn 1');
    expect(text).toContain('✦ claude-sonnet');
    expect(text).toContain('120 in / 45 out');
    expect(text).toContain('│'); // continuation guides
  });

  it('marks incomplete spans with ⚠ and detached subtrees with ⏚', () => {
    const text = renderSpanTree(TREE);
    expect(text).toMatch(/⚙ Bash.*⚠/);
    expect(text).toMatch(/● background agent.*⏚/);
  });

  it('renders orphans under a trailing "(unattached)" section', () => {
    const text = renderSpanTree(TREE);
    const idx = text.indexOf('(unattached)');
    expect(idx).toBeGreaterThan(-1);
    const orphanLine = text.slice(idx);
    expect(orphanLine).toContain('lost tool');
    expect(orphanLine).toContain('✗ boom');
    // The orphan must not appear in the main tree.
    expect(text.slice(0, idx)).not.toContain('lost tool');
  });

  it('collapses deeper levels with --max-depth', () => {
    const text = renderSpanTree(TREE, { maxDepth: 2 });
    expect(text).toContain('turn 1');
    expect(text).not.toContain('claude-sonnet');
    expect(text).toContain('… (2 collapsed)');
  });

  it('renders a single root without connectors gone wrong', () => {
    const text = renderSpanTree([span({ spanId: 'only', kind: 'SESSION', name: 'solo' })]);
    expect(text).toBe('└── ◆ solo  0ms');
  });
});
