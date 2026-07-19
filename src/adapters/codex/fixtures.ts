/**
 * Synthetic Codex rollout fixtures. All content is fabricated for tests —
 * nothing is copied from real ~/.codex files.
 */

export const T0 = Date.parse('2026-06-18T00:00:00.000Z');

export const ROOT_ID = '11111111-1111-4111-8111-111111111111';
export const CHILD_ID = '22222222-2222-4222-8222-222222222222';
export const FORK_ID = '33333333-3333-4333-8333-333333333333';
export const ORPHAN_ID = '44444444-4444-4444-8444-444444444444';

let counter = 0;
/** Deterministic ISO timestamps, `offsetMs` after T0. */
export function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

export function rolloutFileName(threadId: string, offsetMs = 0): string {
  counter += 1;
  const stamp = `2026-06-18T00-00-${String(counter % 60).padStart(2, '0')}`;
  return `rollout-${stamp}-${threadId}.jsonl`;
}

export interface MetaOptions {
  parentThreadId?: string;
  forkedFromId?: string;
  nickname?: string;
  role?: string;
  cliVersion?: string;
  cwd?: string;
  /** When true, encode parentage via `source.subagent.thread_spawn` (new wire shape). */
  viaThreadSpawn?: boolean;
}

export function sessionMetaLine(threadId: string, options: MetaOptions = {}): unknown {
  const payload: Record<string, unknown> = {
    id: threadId,
    timestamp: at(0),
    cwd: options.cwd ?? '/tmp/fixture-project',
    originator: 'codex_cli_rs',
    cli_version: options.cliVersion ?? '0.55.0',
    model_provider: 'openai',
    git: { branch: 'main' },
  };
  if (options.viaThreadSpawn === true && options.parentThreadId !== undefined) {
    payload['source'] = {
      subagent: {
        thread_spawn: {
          parent_thread_id: options.parentThreadId,
          depth: 1,
          agent_path: null,
          agent_nickname: options.nickname ?? null,
          agent_role: options.role ?? null,
        },
      },
    };
  } else {
    payload['source'] = 'cli';
    if (options.parentThreadId !== undefined) payload['parent_thread_id'] = options.parentThreadId;
    if (options.nickname !== undefined) payload['agent_nickname'] = options.nickname;
    if (options.role !== undefined) payload['agent_role'] = options.role;
  }
  if (options.forkedFromId !== undefined) payload['forked_from_id'] = options.forkedFromId;
  return { timestamp: at(0), type: 'session_meta', payload };
}

export function turnContextLine(offsetMs: number, model = 'gpt-5.1-codex'): unknown {
  return {
    timestamp: at(offsetMs),
    type: 'turn_context',
    payload: { cwd: '/tmp/fixture-project', model },
  };
}

export function taskStarted(offsetMs: number, turnId: string): unknown {
  return {
    timestamp: at(offsetMs),
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: turnId, started_at: (T0 + offsetMs) / 1000 },
  };
}

export function taskComplete(offsetMs: number, turnId: string, lastMessage: string): unknown {
  return {
    timestamp: at(offsetMs),
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: turnId, last_agent_message: lastMessage },
  };
}

export function turnAborted(offsetMs: number, turnId: string, reason = 'interrupted'): unknown {
  return {
    timestamp: at(offsetMs),
    type: 'event_msg',
    payload: { type: 'turn_aborted', turn_id: turnId, reason },
  };
}

export function userMessage(offsetMs: number, text: string): unknown {
  return {
    timestamp: at(offsetMs),
    type: 'event_msg',
    payload: { type: 'user_message', message: text },
  };
}

export function agentMessage(offsetMs: number, text: string): unknown {
  return {
    timestamp: at(offsetMs),
    type: 'event_msg',
    payload: { type: 'agent_message', message: text },
  };
}

export function userItem(offsetMs: number, text: string): unknown {
  return {
    timestamp: at(offsetMs),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  };
}

export function assistantItem(offsetMs: number, text: string): unknown {
  return {
    timestamp: at(offsetMs),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  };
}

export function reasoningItem(offsetMs: number, summaryText: string): unknown {
  return {
    timestamp: at(offsetMs),
    type: 'response_item',
    payload: {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: summaryText }],
      content: [],
      encrypted_content: null,
    },
  };
}

export function functionCall(offsetMs: number, name: string, callId: string, args: unknown): unknown {
  return {
    timestamp: at(offsetMs),
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId },
  };
}

export function functionOutput(offsetMs: number, callId: string, output: unknown): unknown {
  return {
    timestamp: at(offsetMs),
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: typeof output === 'string' ? output : JSON.stringify(output),
    },
  };
}

export function tokenCount(
  offsetMs: number,
  usage: { input: number; cached?: number; output: number },
): unknown {
  const cached = usage.cached ?? 0;
  const last = {
    input_tokens: usage.input,
    cached_input_tokens: cached,
    output_tokens: usage.output,
    reasoning_output_tokens: 0,
    total_tokens: usage.input + usage.output,
  };
  return {
    timestamp: at(offsetMs),
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: last, last_token_usage: last } },
  };
}

export function collabSpawnEnd(offsetMs: number, callId: string, newThreadId: string, nickname?: string): unknown {
  return {
    timestamp: at(offsetMs),
    type: 'event_msg',
    payload: {
      type: 'collab_agent_spawn_end',
      call_id: callId,
      sender_thread_id: ROOT_ID,
      new_thread_id: newThreadId,
      ...(nickname !== undefined ? { new_agent_nickname: nickname } : {}),
      prompt: 'synthetic prompt',
      model: 'gpt-5.1-codex',
      status: 'running',
    },
  };
}

/** A plain single-thread rollout: one turn, one tool call, usage, clean end. */
export function singleThreadLines(threadId: string): unknown[] {
  return [
    sessionMetaLine(threadId),
    turnContextLine(10),
    taskStarted(100, 'turn-1'),
    userMessage(110, 'fix the flaky test'),
    userItem(120, 'fix the flaky test'),
    reasoningItem(200, 'thinking about the fix'),
    functionCall(300, 'exec_command', 'call-1', { cmd: 'npm test' }),
    tokenCount(350, { input: 1200, cached: 300, output: 80 }),
    functionOutput(900, 'call-1', '3 passed, 0 failed'),
    assistantItem(1000, 'tests are green now'),
    tokenCount(1050, { input: 1500, cached: 300, output: 40 }),
    agentMessage(1060, 'tests are green now'),
    taskComplete(1100, 'turn-1', 'tests are green now'),
  ];
}

export interface TreeFixtureOptions {
  /** Include collab_agent_spawn_end in the parent (structural join evidence). */
  collab?: boolean;
  /** Include a wait_agent call targeting the child (sync spawn). Default true. */
  wait?: boolean;
  /** Second task_started in the parent after the spawn (parent kept working). */
  parentContinues?: boolean;
  /** Make spawn args/output carry no child identifiers (forces heuristic). */
  anonymousSpawn?: boolean;
  nickname?: string;
}

/**
 * Parent thread with a spawn_agent call + child thread whose session_meta
 * names the parent (via the new thread_spawn wire shape).
 */
export function twoThreadTree(
  options: TreeFixtureOptions = {},
): { parentId: string; childId: string; parent: unknown[]; child: unknown[] } {
  const nickname = options.nickname ?? 'Newton';
  const spawnArgs = options.anonymousSpawn === true ? { message: 'do the subtask' } : { message: `do the subtask, ${nickname}` };
  const spawnOutput =
    options.anonymousSpawn === true
      ? { agent_id: '99999999-9999-4999-8999-999999999999', nickname: null }
      : { agent_id: CHILD_ID, nickname };

  const parent: unknown[] = [
    sessionMetaLine(ROOT_ID),
    turnContextLine(10),
    taskStarted(100, 'turn-1'),
    userMessage(110, 'delegate a subtask'),
    reasoningItem(150, 'should delegate'),
    functionCall(200, 'spawn_agent', 'call-spawn', spawnArgs),
  ];
  if (options.collab === true) {
    parent.push(collabSpawnEnd(250, 'call-spawn', CHILD_ID, nickname));
  }
  parent.push(functionOutput(800, 'call-spawn', spawnOutput));
  if (options.wait !== false) {
    parent.push(functionCall(900, 'wait_agent', 'call-wait', { targets: [CHILD_ID], timeout_ms: 1000 }));
    parent.push(functionOutput(5000, 'call-wait', { status: { [CHILD_ID]: 'completed' }, timed_out: false }));
  }
  parent.push(agentMessage(5100, 'subtask done, results merged'));
  parent.push(taskComplete(5200, 'turn-1', 'subtask done, results merged'));
  if (options.parentContinues === true) {
    parent.push(taskStarted(6000, 'turn-2'));
    parent.push(userMessage(6010, 'now do the follow-up'));
    parent.push(assistantItem(6100, 'follow-up done'));
    parent.push(taskComplete(6200, 'turn-2', 'follow-up done'));
  }

  const child: unknown[] = [
    sessionMetaLine(CHILD_ID, {
      parentThreadId: ROOT_ID,
      nickname,
      role: 'worker',
      viaThreadSpawn: true,
    }),
    turnContextLine(310),
    taskStarted(400, 'child-turn-1'),
    userMessage(410, 'do the subtask'),
    reasoningItem(450, 'working the subtask'),
    functionCall(500, 'exec_command', 'child-call-1', { cmd: 'ls' }),
    functionOutput(700, 'child-call-1', 'file.txt'),
    tokenCount(750, { input: 500, output: 20 }),
    agentMessage(760, 'subtask complete'),
    taskComplete(800, 'child-turn-1', 'subtask complete'),
  ];

  return { parentId: ROOT_ID, childId: CHILD_ID, parent, child };
}

/** Thread whose only turn is aborted. */
export function abortedThreadLines(threadId: string): unknown[] {
  return [
    sessionMetaLine(threadId),
    turnContextLine(10),
    taskStarted(100, 'turn-1'),
    userMessage(110, 'long running thing'),
    reasoningItem(200, 'starting'),
    turnAborted(5000, 'turn-1', 'interrupted'),
  ];
}

/** Thread forked from another (forked_from_id, no spawn call anywhere). */
export function forkedThreadLines(threadId: string, forkedFromId: string): unknown[] {
  return [
    sessionMetaLine(threadId, { forkedFromId }),
    turnContextLine(7000),
    taskStarted(7100, 'fork-turn-1'),
    userMessage(7110, 'continue from the fork'),
    assistantItem(7200, 'fork answer'),
    taskComplete(7300, 'fork-turn-1', 'fork answer'),
  ];
}

export function toJsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
