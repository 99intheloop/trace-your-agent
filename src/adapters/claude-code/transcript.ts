/**
 * Raw transcript row model for Claude Code session files (`*.jsonl`).
 *
 * Every line is one JSON object. The shapes below are intentionally loose
 * (`unknown` fields + guards): the on-disk format is not versioned formally,
 * so parsing must degrade gracefully instead of trusting any field.
 *
 * Verified against real `~/.claude/projects/<cwd>/<sessionId>.jsonl` files
 * (structure only — fixtures and tests use synthetic data).
 */

/** Row types we fully ignore (no spans, no timestamps contributed). */
export const IGNORED_TYPES = new Set([
  'queue-operation',
  'attachment',
  'permission-mode',
  'last-prompt',
  'file-history-snapshot',
]);

export interface CcRow {
  uuid?: unknown;
  parentUuid?: unknown;
  type?: unknown;
  subtype?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  isSidechain?: unknown;
  agentId?: unknown;
  message?: unknown;
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: unknown;
  durationMs?: unknown;
  messageCount?: unknown;
  version?: unknown;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Parse one JSONL line; `null` on malformed input (the line is skipped). */
export function parseRow(line: string): CcRow | null {
  if (line.trim() === '') return null;
  try {
    const obj: unknown = JSON.parse(line);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj as CcRow;
  } catch {
    return null;
  }
}

/** Parse a millisecond timestamp from an ISO string field; `undefined` when invalid. */
export function parseTs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

export interface CcUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Map Anthropic `usage` fields onto our token model. */
export function parseUsage(v: unknown): CcUsage | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const u = v as Record<string, unknown>;
  const out: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } = {};
  const input = num(u['input_tokens']);
  const output = num(u['output_tokens']);
  const cacheRead = num(u['cache_read_input_tokens']);
  const cacheWrite = num(u['cache_creation_input_tokens']);
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) out.cacheWriteTokens = cacheWrite;
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface CcBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  toolUseId?: string;
  content?: unknown;
  isError?: boolean;
}

function asBlock(v: unknown): CcBlock | null {
  if (v === null || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  const type = str(b['type']);
  if (type === undefined) return null;
  const block: CcBlock = { type };
  const text = str(b['text']);
  const id = str(b['id']);
  const name = str(b['name']);
  const toolUseId = str(b['tool_use_id']);
  if (text !== undefined) block.text = text;
  if (id !== undefined) block.id = id;
  if (name !== undefined) block.name = name;
  if ('input' in b) block.input = b['input'];
  if (toolUseId !== undefined) block.toolUseId = toolUseId;
  if ('content' in b) block.content = b['content'];
  if (b['is_error'] === true) block.isError = true;
  return block;
}

export interface CcMessageView {
  model?: string;
  /** Content blocks when `content` is an array; `null` for string/absent content. */
  blocks: CcBlock[] | null;
  /** Plain-text view of the content (string content as-is, text blocks joined). */
  text: string;
  usage?: CcUsage;
}

/**
 * True for user rows that carry tool results. Main transcripts set a top-level
 * `toolUseResult` field; sidechain files (observed on CC 2.1.x) carry only the
 * `tool_result` content block without that field — both forms must match.
 */
export function isToolResultRow(row: CcRow, msg: CcMessageView | undefined): boolean {
  if (row.toolUseResult !== undefined) return true;
  return msg?.blocks?.some((b) => b.type === 'tool_result') ?? false;
}

/** Normalize a row's `message` field (Anthropic API message shape). */
export function viewMessage(v: unknown): CcMessageView | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  const content = m['content'];
  let blocks: CcBlock[] | null = null;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    blocks = [];
    const texts: string[] = [];
    for (const raw of content) {
      const block = asBlock(raw);
      if (block === null) continue;
      blocks.push(block);
      if (block.type === 'text' && block.text !== undefined) texts.push(block.text);
    }
    text = texts.join('\n');
  }
  const model = str(m['model']);
  const usage = parseUsage(m['usage']);
  const view: CcMessageView = { blocks, text };
  if (model !== undefined) view.model = model;
  if (usage !== undefined) view.usage = usage;
  return view;
}

/** Text of a `tool_result` block: string content as-is, or text blocks joined. */
export function toolResultText(block: CcBlock): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content) {
      const b = asBlock(raw);
      if (b !== null && b.type === 'text' && b.text !== undefined) parts.push(b.text);
    }
    return parts.join('\n');
  }
  return '';
}
