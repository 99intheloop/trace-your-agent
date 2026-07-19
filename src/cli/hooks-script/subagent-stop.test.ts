import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendJoinRecord,
  recordFromHookInput,
  runSubagentStopHook,
} from './subagent-stop.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tya-hookscript-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Shape verified against claude_code/src/entrypoints/sdk/coreSchemas.ts
// (BaseHookInputSchema + SubagentStopHookInputSchema).
const FULL_INPUT = {
  session_id: 'sess-abc',
  transcript_path: '/Users/x/.claude/projects/p/main.jsonl',
  cwd: '/repo',
  permission_mode: 'default',
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  agent_id: 'agent-42',
  agent_type: 'Explore',
  agent_transcript_path: '/Users/x/.claude/projects/p/agent-42.jsonl',
  last_assistant_message: 'done',
};

describe('recordFromHookInput', () => {
  it('extracts every field present in a real SubagentStop input', () => {
    const record = recordFromHookInput(FULL_INPUT, new Date(1_700_000_000_000));
    expect(record).toEqual({
      ts: new Date(1_700_000_000_000).toISOString(),
      event: 'subagent-stop',
      sessionId: 'sess-abc',
      agentId: 'agent-42',
      agentType: 'Explore',
      agentTranscriptPath: '/Users/x/.claude/projects/p/agent-42.jsonl',
      transcriptPath: '/Users/x/.claude/projects/p/main.jsonl',
      cwd: '/repo',
    });
  });

  it('degrades to ts+event on garbage input and never throws', () => {
    for (const garbage of [undefined, null, 42, 'nope', [], { session_id: 7 }]) {
      const record = recordFromHookInput(garbage);
      expect(record.event).toBe('subagent-stop');
      expect(record.ts).toBeTruthy();
    }
    const partial = recordFromHookInput({ session_id: 's', agent_id: 'a' });
    expect(partial.sessionId).toBe('s');
    expect(partial.agentId).toBe('a');
    expect(partial.agentType).toBeUndefined();
  });

  it('picks up a task/tool_use id if CC ever sends one', () => {
    const record = recordFromHookInput({ ...FULL_INPUT, tool_use_id: 'toolu_123' });
    expect(record.taskToolUseId).toBe('toolu_123');
  });
});

describe('runSubagentStopHook', () => {
  it('appends one JSON line to joins.jsonl and always resolves 0', async () => {
    const stdin = Readable.from([JSON.stringify(FULL_INPUT)]);
    const code = await runSubagentStopHook(stdin, { TYA_HOME: dir }, { timeoutMs: 500 });
    expect(code).toBe(0);
    const lines = readFileSync(join(dir, 'joins.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(record['sessionId']).toBe('sess-abc');
    expect(record['agentId']).toBe('agent-42');
    expect(record['parseError']).toBeUndefined();
  });

  it('survives invalid JSON on stdin (still exit 0, records parseError)', async () => {
    const stdin = Readable.from(['{not json']);
    const code = await runSubagentStopHook(stdin, { TYA_HOME: dir }, { timeoutMs: 500 });
    expect(code).toBe(0);
    const record = JSON.parse(
      readFileSync(join(dir, 'joins.jsonl'), 'utf8').trim(),
    ) as Record<string, unknown>;
    expect(record['parseError']).toBe(true);
  });

  it('does not block past the timeout when stdin never ends', async () => {
    const stdin = new Readable({ read() {} }); // never emits, never ends
    const start = Date.now();
    const code = await runSubagentStopHook(stdin, { TYA_HOME: dir }, { timeoutMs: 50 });
    expect(code).toBe(0);
    expect(Date.now() - start).toBeLessThan(2000);
    stdin.destroy();
  });

  it('appendJoinRecord creates the home directory if missing', () => {
    const nested = join(dir, 'deep', 'home');
    appendJoinRecord(nested, { ts: 't', event: 'subagent-stop', sessionId: 's' });
    const lines = readFileSync(join(nested, 'joins.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });
});
