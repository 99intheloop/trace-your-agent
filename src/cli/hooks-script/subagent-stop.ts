import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveTyaHome } from '../../core/home.js';

/**
 * Claude Code SubagentStop hook script (built to dist/hooks/subagent-stop.js,
 * installed by `tya install-hooks claude-code`).
 *
 * Reads the hook input JSON from stdin and appends one line to
 * `<TYA_HOME>/joins.jsonl`. It runs inside Claude Code's toolchain, so it
 * MUST never exit non-zero and never block longer than ~2s.
 *
 * What CC actually sends on stdin for SubagentStop (verified against
 * claude_code/src/entrypoints/sdk/coreSchemas.ts — BaseHookInputSchema +
 * SubagentStopHookInputSchema):
 *   session_id, transcript_path, cwd, permission_mode?,
 *   hook_event_name: "SubagentStop", stop_hook_active,
 *   agent_id, agent_type, agent_transcript_path, last_assistant_message?
 * There is NO Task tool_use id in the input; we record what exists.
 */

export interface SubagentStopJoinRecord {
  /** ISO timestamp when the hook fired. */
  ts: string;
  event: 'subagent-stop';
  sessionId?: string;
  agentId?: string;
  agentType?: string;
  agentTranscriptPath?: string;
  transcriptPath?: string;
  cwd?: string;
  /** Present only if CC ever includes a task/tool_use id in the input. */
  taskToolUseId?: string;
  /** True when stdin was empty or not valid JSON. */
  parseError?: boolean;
}

function pickString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Extract the join record from the parsed hook input. Never throws. */
export function recordFromHookInput(input: unknown, now: Date = new Date()): SubagentStopJoinRecord {
  const record: SubagentStopJoinRecord = { ts: now.toISOString(), event: 'subagent-stop' };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return record;
  const obj = input as Record<string, unknown>;
  const sessionId = pickString(obj, 'session_id');
  if (sessionId !== undefined) record.sessionId = sessionId;
  const agentId = pickString(obj, 'agent_id');
  if (agentId !== undefined) record.agentId = agentId;
  const agentType = pickString(obj, 'agent_type');
  if (agentType !== undefined) record.agentType = agentType;
  const agentTranscriptPath = pickString(obj, 'agent_transcript_path');
  if (agentTranscriptPath !== undefined) record.agentTranscriptPath = agentTranscriptPath;
  const transcriptPath = pickString(obj, 'transcript_path');
  if (transcriptPath !== undefined) record.transcriptPath = transcriptPath;
  const cwd = pickString(obj, 'cwd');
  if (cwd !== undefined) record.cwd = cwd;
  const taskToolUseId = pickString(obj, 'task_tool_use_id') ?? pickString(obj, 'tool_use_id');
  if (taskToolUseId !== undefined) record.taskToolUseId = taskToolUseId;
  return record;
}

/** Append one record to `<homeDir>/joins.jsonl`. */
export function appendJoinRecord(homeDir: string, record: SubagentStopJoinRecord): void {
  mkdirSync(homeDir, { recursive: true });
  appendFileSync(join(homeDir, 'joins.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
}

function readStdinWithTimeout(stdin: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const finish = () => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', finish);
      stdin.off('error', finish);
      stdin.pause();
      resolve(data);
    };
    const onData = (chunk: Buffer | string) => {
      data += chunk.toString();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    stdin.on('data', onData);
    stdin.on('end', finish);
    stdin.on('error', finish);
    stdin.resume();
  });
}

/**
 * Run the hook. Always resolves 0 — a hook in someone else's toolchain must
 * never fail. `timeoutMs` caps how long we wait for stdin (default 2000).
 */
export async function runSubagentStopHook(
  stdin: NodeJS.ReadableStream,
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number; now?: Date } = {},
): Promise<number> {
  try {
    const input = await readStdinWithTimeout(stdin, options.timeoutMs ?? 2000);
    let parsed: unknown;
    let parseError = false;
    try {
      parsed = JSON.parse(input);
    } catch {
      parseError = true;
    }
    const record = recordFromHookInput(parsed, options.now ?? new Date());
    if (parseError) record.parseError = true;
    appendJoinRecord(resolveTyaHome(env), record);
  } catch {
    // Swallow everything: exit 0 no matter what.
  }
  return 0;
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  void runSubagentStopHook(process.stdin, process.env).then((code) => process.exit(code));
}
