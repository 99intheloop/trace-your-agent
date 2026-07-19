/**
 * Synthetic Claude Code transcript fixtures. Every byte here is made up for
 * tests — no real session content. Timestamps are fixed (2026-01-01) so
 * span ids and snapshots are deterministic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

export function ts(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

const BASE = {
  userType: 'external',
  entrypoint: 'cli',
  cwd: '/Users/test/proj',
  version: '2.1.0',
  gitBranch: 'main',
};

export function userPrompt(uuid: string, sessionId: string, text: string, tsMs: number, extra: Record<string, unknown> = {}): string {
  return line({
    ...BASE,
    uuid,
    parentUuid: null,
    type: 'user',
    timestamp: ts(tsMs),
    sessionId,
    isSidechain: false,
    message: { role: 'user', content: text },
    ...extra,
  });
}

export function assistantRow(
  uuid: string,
  sessionId: string,
  content: unknown[],
  tsMs: number,
  usage: Record<string, number> | undefined,
  extra: Record<string, unknown> = {},
): string {
  const msg: Record<string, unknown> = {
    id: `msg_${uuid}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-fixture-1',
    content,
  };
  if (usage !== undefined) msg['usage'] = usage;
  return line({
    ...BASE,
    uuid,
    type: 'assistant',
    timestamp: ts(tsMs),
    sessionId,
    isSidechain: false,
    message: msg,
    ...extra,
  });
}

export function toolResultRow(
  uuid: string,
  sessionId: string,
  toolUseId: string,
  resultText: string,
  tsMs: number,
  extra: Record<string, unknown> = {},
): string {
  return line({
    ...BASE,
    uuid,
    type: 'user',
    timestamp: ts(tsMs),
    sessionId,
    isSidechain: false,
    toolUseResult: { stdout: resultText, stderr: '', interrupted: false },
    sourceToolAssistantUUID: 'src-ignored',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: resultText }],
    },
    ...extra,
  });
}

export function turnDurationRow(uuid: string, sessionId: string, durationMs: number, messageCount: number, tsMs: number): string {
  return line({
    ...BASE,
    uuid,
    type: 'system',
    subtype: 'turn_duration',
    durationMs,
    messageCount,
    timestamp: ts(tsMs),
    sessionId,
    isSidechain: false,
    isMeta: true,
  });
}

export function textBlock(text: string): Record<string, unknown> {
  return { type: 'text', text };
}

export function toolUseBlock(id: string, name: string, input: unknown): Record<string, unknown> {
  return { type: 'tool_use', id, name, input };
}

export const USAGE_PLAIN = { input_tokens: 120, output_tokens: 30 };
export const USAGE_CACHED = {
  input_tokens: 200,
  output_tokens: 60,
  cache_read_input_tokens: 500,
  cache_creation_input_tokens: 40,
};
export const USAGE_PLAIN_2 = { input_tokens: 300, output_tokens: 20 };

// ---------------------------------------------------------------- sessions

/** Fixture 1: single plain turn (user → assistant(text) → turn_duration). */
export const SIMPLE_SESSION = 'sess-simple';
export const SIMPLE_MAIN =
  userPrompt('s-u1', SIMPLE_SESSION, 'Fix the login bug', 0) +
  assistantRow('s-a1', SIMPLE_SESSION, [textBlock("I'll look into it.")], 1000, USAGE_PLAIN) +
  turnDurationRow('s-sys1', SIMPLE_SESSION, 1800, 2, 2000);

/** Fixture 2: tool-call turn with cache usage. */
export const TOOLS_SESSION = 'sess-tools';
export const TOOLS_MAIN =
  userPrompt('t-u1', TOOLS_SESSION, 'Run the tests', 0) +
  assistantRow(
    't-a1',
    TOOLS_SESSION,
    [textBlock('Running.'), toolUseBlock('toolu_t1', 'Bash', { command: 'npm test' })],
    1000,
    USAGE_CACHED,
  ) +
  toolResultRow('t-u2', TOOLS_SESSION, 'toolu_t1', 'all tests passed', 4000) +
  assistantRow('t-a2', TOOLS_SESSION, [textBlock('All green.')], 5000, USAGE_PLAIN_2) +
  turnDurationRow('t-sys1', TOOLS_SESSION, 5500, 4, 6000);

/** Fixture 3: main session spawning a subagent (heuristic join via prompt match). */
export const SUB_SESSION = 'sess-sub';
export const SUB_AGENT_ID = 'aabbcc';
export const SUB_TASK_PROMPT = 'find all adapters';
export const SUB_MAIN =
  userPrompt('b-u1', SUB_SESSION, 'Explore the codebase', 0) +
  assistantRow(
    'b-a1',
    SUB_SESSION,
    [toolUseBlock('toolu_task1', 'Task', { description: 'explore', prompt: SUB_TASK_PROMPT, subagent_type: 'Explore' })],
    1000,
    USAGE_PLAIN,
  ) +
  toolResultRow('b-u2', SUB_SESSION, 'toolu_task1', 'explored 3 adapters', 6000) +
  assistantRow('b-a2', SUB_SESSION, [textBlock('Done.')], 7000, USAGE_PLAIN_2) +
  turnDurationRow('b-sys1', SUB_SESSION, 7500, 4, 8000);
export const SUB_SIDECHAIN =
  userPrompt('b-sc-u1', SUB_SESSION, SUB_TASK_PROMPT, 2000, { isSidechain: true, agentId: SUB_AGENT_ID }) +
  assistantRow('b-sc-a1', SUB_SESSION, [textBlock('Searching.')], 3000, USAGE_PLAIN, { isSidechain: true, agentId: SUB_AGENT_ID }) +
  assistantRow(
    'b-sc-a2',
    SUB_SESSION,
    [toolUseBlock('toolu_g1', 'Glob', { pattern: 'src/**/*.ts' })],
    3500,
    undefined,
    { isSidechain: true, agentId: SUB_AGENT_ID },
  ) +
  toolResultRow('b-sc-u2', SUB_SESSION, 'toolu_g1', 'src/a.ts\nsrc/b.ts', 4500, { isSidechain: true, agentId: SUB_AGENT_ID }) +
  assistantRow('b-sc-a3', SUB_SESSION, [textBlock('Found 3 adapters.')], 5000, USAGE_PLAIN_2, {
    isSidechain: true,
    agentId: SUB_AGENT_ID,
  });
export const SUB_META = JSON.stringify({ agentType: 'Explore', description: 'Explore codebase' }, null, 2);

/** Fixture 4: interrupted session (turn + tool call never close). */
export const INT_SESSION = 'sess-int';
export const INT_MAIN =
  userPrompt('i-u1', INT_SESSION, 'do something slow', 0) +
  assistantRow('i-a1', INT_SESSION, [toolUseBlock('toolu_x1', 'Bash', { command: 'sleep 999' })], 1000, USAGE_PLAIN);

/** Fixture 5: structural join via joins.jsonl sidecar (prompt deliberately mismatching). */
export const JOIN_SESSION = 'sess-join';
export const JOIN_AGENT_ID = 'zz99';
export const JOIN_MAIN =
  userPrompt('j-u1', JOIN_SESSION, 'Analyze the logs', 0) +
  assistantRow(
    'j-a1',
    JOIN_SESSION,
    [toolUseBlock('toolu_j1', 'Task', { description: 'analyze', prompt: 'analyze logs' })],
    1000,
    USAGE_PLAIN,
  ) +
  toolResultRow('j-u2', JOIN_SESSION, 'toolu_j1', 'analysis done', 5000) +
  turnDurationRow('j-sys1', JOIN_SESSION, 5200, 3, 6000);
export const JOIN_SIDECHAIN =
  userPrompt('j-sc-u1', JOIN_SESSION, 'COMPLETELY DIFFERENT PROMPT', 2000, { isSidechain: true, agentId: JOIN_AGENT_ID }) +
  assistantRow('j-sc-a1', JOIN_SESSION, [textBlock('Analyzing.')], 3000, USAGE_PLAIN_2, { isSidechain: true, agentId: JOIN_AGENT_ID });
export const JOIN_SIDECAR_LINE = JSON.stringify({ sessionId: JOIN_SESSION, agentId: JOIN_AGENT_ID, toolUseId: 'toolu_j1' });

/** Fixture 6: orphan subagent (no meta, no sidecar, prompt mismatch). */
export const ORPHAN_SESSION = 'sess-orphan';
export const ORPHAN_AGENT_ID = 'orp1';
export const ORPHAN_MAIN =
  userPrompt('o-u1', ORPHAN_SESSION, 'hello', 0) +
  assistantRow('o-a1', ORPHAN_SESSION, [textBlock('hi')], 1000, USAGE_PLAIN) +
  turnDurationRow('o-sys1', ORPHAN_SESSION, 900, 2, 2000);
export const ORPHAN_SIDECHAIN =
  userPrompt('o-sc-u1', ORPHAN_SESSION, 'unmatched prompt', 500, { isSidechain: true, agentId: ORPHAN_AGENT_ID }) +
  assistantRow('o-sc-a1', ORPHAN_SESSION, [textBlock('working')], 800, USAGE_PLAIN, { isSidechain: true, agentId: ORPHAN_AGENT_ID });

// ---------------------------------------------------------------- materialization

const PROJECT_DIR = '-Users-test-proj';

export interface FakeHome {
  claudeHome: string;
  tyaHome: string;
  sessionFile: (sessionId: string) => string;
}

function write(root: string, rel: string, content: string): string {
  const filePath = join(root, rel);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/** Materialize all fixtures under `root` (a fresh tmp dir) as a fake ~/.claude. */
export function materializeHome(root: string): FakeHome {
  const claudeHome = join(root, 'claude');
  const tyaHome = join(root, 'tya');
  const proj = join('projects', PROJECT_DIR);
  write(claudeHome, join(proj, `${SIMPLE_SESSION}.jsonl`), SIMPLE_MAIN);
  write(claudeHome, join(proj, `${TOOLS_SESSION}.jsonl`), TOOLS_MAIN);
  write(claudeHome, join(proj, `${SUB_SESSION}.jsonl`), SUB_MAIN);
  write(claudeHome, join(proj, SUB_SESSION, 'subagents', `agent-${SUB_AGENT_ID}.jsonl`), SUB_SIDECHAIN);
  write(claudeHome, join(proj, SUB_SESSION, 'subagents', `agent-${SUB_AGENT_ID}.meta.json`), SUB_META);
  write(claudeHome, join(proj, `${INT_SESSION}.jsonl`), INT_MAIN);
  write(claudeHome, join(proj, `${JOIN_SESSION}.jsonl`), JOIN_MAIN);
  write(claudeHome, join(proj, JOIN_SESSION, 'subagents', `agent-${JOIN_AGENT_ID}.jsonl`), JOIN_SIDECHAIN);
  write(claudeHome, join(proj, `${ORPHAN_SESSION}.jsonl`), ORPHAN_MAIN);
  write(claudeHome, join(proj, ORPHAN_SESSION, 'subagents', `agent-${ORPHAN_AGENT_ID}.jsonl`), ORPHAN_SIDECHAIN);
  write(tyaHome, 'joins.jsonl', `${JOIN_SIDECAR_LINE}\n`);
  return {
    claudeHome,
    tyaHome,
    sessionFile: (sessionId: string) => join(claudeHome, proj, `${sessionId}.jsonl`),
  };
}
