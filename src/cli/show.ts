import { parseArgs } from 'node:util';
import { ATTR, type Span, type SpanKind } from '../core/types.js';
import { err, formatDuration, openStore, out } from './util.js';

const HELP = `tya show — Show the span tree of one session

Usage: tya show <sessionId> [options]

Options:
  --max-depth <N>  Only render the tree down to this depth
  -h, --help       Show this help

Markers: ⏚ detached subtree, ⚠ incomplete (closed at EOF), ✗ error.
Spans whose parent is missing are listed under "(unattached)" at the end.
`;

const KIND_ICONS: Record<SpanKind, string> = {
  SESSION: '◆',
  AGENT_TURN: '●',
  LLM_CALL: '✦',
  TOOL_CALL: '⚙',
};

export interface RenderTreeOptions {
  /** Maximum depth to render (roots are depth 1). Deeper spans collapse into "…". */
  maxDepth?: number;
}

interface TreeNode {
  span: Span;
  children: TreeNode[];
}

function byStart(a: TreeNode, b: TreeNode): number {
  return a.span.startTimeMs - b.span.startTimeMs || a.span.spanId.localeCompare(b.span.spanId);
}

function buildForest(spans: readonly Span[]): { roots: TreeNode[]; orphans: TreeNode[] } {
  const nodes = new Map<string, TreeNode>();
  for (const span of spans) nodes.set(span.spanId, { span, children: [] });
  const roots: TreeNode[] = [];
  const orphans: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.span.parentSpanId;
    if (parentId === undefined) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(parentId);
    if (parent === undefined) {
      orphans.push(node);
      continue;
    }
    parent.children.push(node);
  }
  for (const node of nodes.values()) node.children.sort(byStart);
  roots.sort(byStart);
  orphans.sort(byStart);
  return { roots, orphans };
}

function spanLabel(span: Span): string {
  const icon = KIND_ICONS[span.kind];
  let label = `${icon} ${span.name}  ${formatDuration(span.durationMs)}`;
  if (span.tokenUsage !== undefined) {
    label += `  ${span.tokenUsage.inputTokens} in / ${span.tokenUsage.outputTokens} out`;
  }
  if (span.attributes[ATTR.DETACHED] === true) label += ' ⏚';
  if (span.attributes[ATTR.INCOMPLETE] === true) label += ' ⚠';
  if (span.status.code === 'error') {
    label += span.status.message !== undefined ? ` ✗ ${span.status.message}` : ' ✗';
  }
  return label;
}

function renderNode(
  node: TreeNode,
  prefix: string,
  isLast: boolean,
  depth: number,
  maxDepth: number | undefined,
  lines: string[],
): void {
  lines.push(`${prefix}${isLast ? '└── ' : '├── '}${spanLabel(node.span)}`);
  const childPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
  if (node.children.length === 0) return;
  if (maxDepth !== undefined && depth >= maxDepth) {
    lines.push(`${childPrefix}└── … (${node.children.length} collapsed)`);
    return;
  }
  node.children.forEach((child, i) => {
    renderNode(child, childPrefix, i === node.children.length - 1, depth + 1, maxDepth, lines);
  });
}

/**
 * Render a session's spans as an indented ASCII tree.
 * Spans whose parentSpanId points at a span that is not in the input
 * ("orphans") are rendered under a trailing "(unattached)" section.
 */
export function renderSpanTree(spans: readonly Span[], options: RenderTreeOptions = {}): string {
  const maxDepth = options.maxDepth;
  const { roots, orphans } = buildForest(spans);
  const lines: string[] = [];
  roots.forEach((node, i) => renderNode(node, '', i === roots.length - 1, 1, maxDepth, lines));
  if (orphans.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('(unattached)');
    orphans.forEach((node, i) => renderNode(node, '', i === orphans.length - 1, 1, maxDepth, lines));
  }
  return lines.join('\n');
}

export async function runShowCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      'max-depth': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  if (values.help === true) {
    out(HELP);
    return 0;
  }
  const sessionId = positionals[0];
  if (sessionId === undefined) {
    err('tya show: missing <sessionId>. See `tya show --help`.');
    return 1;
  }
  let maxDepth: number | undefined;
  if (values['max-depth'] !== undefined) {
    maxDepth = Number(values['max-depth']);
    if (!Number.isInteger(maxDepth) || maxDepth <= 0) {
      err('tya show: --max-depth must be a positive integer');
      return 1;
    }
  }

  const { store, close } = openStore();
  try {
    const spans = store.getSessionSpans(sessionId);
    if (spans.length === 0) {
      err(`tya show: session not found: ${sessionId}`);
      return 1;
    }
    const sessionRow = store.getSessionRow(sessionId);
    if (sessionRow !== undefined) {
      out(
        `session ${sessionRow.sessionId}  (${sessionRow.source})  ` +
          `${sessionRow.spanCount} spans, ${sessionRow.turnCount} turns, ` +
          `${sessionRow.totalInputTokens}+${sessionRow.totalOutputTokens} tokens, ` +
          `$${sessionRow.totalCostUsd.toFixed(4)}, ${sessionRow.errorCount} error(s)`,
      );
      out('');
    }
    out(renderSpanTree(spans, maxDepth !== undefined ? { maxDepth } : {}));
    return 0;
  } finally {
    close();
  }
}
