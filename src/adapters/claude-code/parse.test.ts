import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { traceIdFor } from '../../core/ids.js';
import { PayloadStore } from '../../core/payload-store.js';
import type { DetectedHome, SessionRef } from '../../core/source.js';
import { TraceStore } from '../../store/store.js';
import { ATTR, type Span } from '../../core/types.js';
import { ClaudeCodeAdapter } from './adapter.js';
import {
  AGENT_TOOL_AGENT_ID,
  AGENT_TOOL_SESSION,
  INT_SESSION,
  JOIN_AGENT_ID,
  JOIN_SESSION,
  materializeHome,
  ORPHAN_AGENT_ID,
  ORPHAN_SESSION,
  SIMPLE_SESSION,
  SUB_AGENT_ID,
  SUB_SESSION,
  TOOLS_SESSION,
  type FakeHome,
} from './fixtures.js';
import { collectSpans, treeView, type HarnessResult } from './testkit.js';

let root: string;
let home: FakeHome;
let adapter: ClaudeCodeAdapter;
let sessions: Map<string, SessionRef>;
let store: TraceStore;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tya-cc-parse-'));
  home = materializeHome(root);
  store = new TraceStore(':memory:');
  const payloadStore = new PayloadStore(join(home.tyaHome));
  adapter = new ClaudeCodeAdapter({ claudeHome: home.claudeHome, tyaHome: home.tyaHome, payloadStore });
  const detected = (await adapter.detect()) as DetectedHome;
  sessions = new Map();
  for await (const ref of adapter.discover(detected)) sessions.set(ref.sessionId, ref);
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

async function run(sessionId: string, fromOffset = 0): Promise<HarnessResult> {
  const ref = sessions.get(sessionId);
  if (ref === undefined) throw new Error(`fixture session missing: ${sessionId}`);
  return collectSpans(traceIdFor('claude-code', sessionId), adapter.parse(ref, fromOffset));
}

function byKind(result: HarnessResult, kind: Span['kind']): Span[] {
  return result.spans.filter((s) => s.kind === kind);
}

function one(spans: Span[], pred: (s: Span) => boolean, what: string): Span {
  const found = spans.filter(pred);
  expect(found, what).toHaveLength(1);
  return found[0]!;
}

describe('parse: simple single turn', () => {
  let result: HarnessResult;
  beforeAll(async () => {
    result = await run(SIMPLE_SESSION);
  });

  it('builds SESSION > AGENT_TURN > LLM_CALL with correct parents', () => {
    expect(result.spans).toHaveLength(3);
    const session = one(result.spans, (s) => s.kind === 'SESSION', 'session');
    const turn = one(result.spans, (s) => s.kind === 'AGENT_TURN', 'turn');
    const llm = one(result.spans, (s) => s.kind === 'LLM_CALL', 'llm');
    expect(session.parentSpanId).toBeUndefined();
    expect(turn.parentSpanId).toBe(session.spanId);
    expect(llm.parentSpanId).toBe(turn.spanId);
  });

  it('session span carries session.id / source / cwd', () => {
    const session = one(result.spans, (s) => s.kind === 'SESSION', 'session');
    expect(session.attributes[ATTR.SESSION_ID]).toBe(SIMPLE_SESSION);
    expect(session.attributes[ATTR.SOURCE]).toBe('claude-code');
    expect(session.attributes['cwd']).toBe('/Users/test/proj');
    expect(result.meta?.cwd).toBe('/Users/test/proj');
  });

  it('turn closes on turn_duration with the authoritative durationMs', () => {
    const turn = one(result.spans, (s) => s.kind === 'AGENT_TURN', 'turn');
    expect(turn.durationMs).toBe(1800);
    expect(turn.attributes['turn.messageCount']).toBe(2);
    expect(turn.attributes['turn.rowCount']).toBe(3);
    expect(turn.attributes[ATTR.INCOMPLETE]).toBeUndefined();
  });

  it('LLM_CALL is approx (duration = delta to previous row), with model + usage', () => {
    const llm = one(result.spans, (s) => s.kind === 'LLM_CALL', 'llm');
    expect(llm.attributes[ATTR.APPROX]).toBe(true);
    expect(llm.durationMs).toBe(1000);
    expect(llm.attributes[ATTR.GEN_AI_MODEL]).toBe('claude-fixture-1');
    expect(llm.tokenUsage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(llm.inputSummary).toBe('Fix the login bug');
    expect(llm.outputSummary).toBe("I'll look into it.");
  });

  it('matches the snapshot', () => {
    expect(treeView(result.spans)).toMatchSnapshot();
  });
});

describe('parse: tool-call turn with cache usage', () => {
  let result: HarnessResult;
  beforeAll(async () => {
    result = await run(TOOLS_SESSION);
  });

  it('pairs tool_use with tool_result into one TOOL_CALL', () => {
    expect(byKind(result, 'SESSION')).toHaveLength(1);
    expect(byKind(result, 'AGENT_TURN')).toHaveLength(1);
    expect(byKind(result, 'LLM_CALL')).toHaveLength(2);
    const tool = one(result.spans, (s) => s.kind === 'TOOL_CALL', 'tool');
    const turn = one(result.spans, (s) => s.kind === 'AGENT_TURN', 'turn');
    expect(tool.parentSpanId).toBe(turn.spanId);
    expect(tool.toolName).toBe('Bash');
    expect(tool.durationMs).toBe(3000);
    expect(tool.inputSummary).toBe('{"command":"npm test"}');
    expect(tool.outputSummary).toBe('all tests passed');
    expect(tool.status.code).toBe('ok');
  });

  it('stores the full input/result in the payload store', () => {
    const tool = one(result.spans, (s) => s.kind === 'TOOL_CALL', 'tool');
    expect(tool.payloadRef).toMatch(/^payloads\/[0-9a-f]{64}\.json$/);
    const payload = new PayloadStore(home.tyaHome).get(tool.payloadRef!) as Record<string, unknown>;
    expect(payload['tool']).toBe('Bash');
    expect(payload['input']).toEqual({ command: 'npm test' });
    expect(payload['result']).toBe('all tests passed');
  });

  it('maps cache usage fields onto the token model', () => {
    const llms = byKind(result, 'LLM_CALL').sort((a, b) => a.startTimeMs - b.startTimeMs);
    expect(llms[0]!.tokenUsage).toEqual({
      inputTokens: 200,
      outputTokens: 60,
      cacheReadTokens: 500,
      cacheWriteTokens: 40,
    });
    expect(llms[1]!.tokenUsage).toEqual({ inputTokens: 300, outputTokens: 20 });
    expect(llms[1]!.durationMs).toBe(1000); // 5000 - 4000 (tool_result row)
    expect(llms[1]!.inputSummary).toBe('all tests passed');
  });

  it('aggregates usage in the store', () => {
    store.insertSpans(result.spans);
    const stats = store.getStats(TOOLS_SESSION);
    expect(stats.byKind).toEqual({ SESSION: 1, AGENT_TURN: 1, LLM_CALL: 2, TOOL_CALL: 1 });
    expect(stats.totalInputTokens).toBe(500);
    expect(stats.totalOutputTokens).toBe(80);
    expect(stats.totalCacheReadTokens).toBe(500);
    expect(stats.totalCacheWriteTokens).toBe(40);
    expect(stats.incompleteCount).toBe(0);
    const row = store.getSessionRow(TOOLS_SESSION);
    expect(row?.turnCount).toBe(1);
    expect(row?.source).toBe('claude-code');
  });

  it('matches the snapshot', () => {
    expect(treeView(result.spans)).toMatchSnapshot();
  });
});

describe('parse: subagent sidechain (heuristic join)', () => {
  let result: HarnessResult;
  beforeAll(async () => {
    result = await run(SUB_SESSION);
  });

  it('builds the full tree: main + sidechain under the Task span', () => {
    expect(result.spans).toHaveLength(10);
    const task = one(result.spans, (s) => s.toolName === 'Task', 'task span');
    const sideTurn = one(
      result.spans,
      (s) => s.kind === 'AGENT_TURN' && s.attributes[ATTR.AGENT_ID] === SUB_AGENT_ID,
      'sidechain turn',
    );
    expect(sideTurn.parentSpanId).toBe(task.spanId);
    // sidechain LLM/tool spans hang under the sidechain turn
    const sideChildren = result.spans.filter((s) => s.parentSpanId === sideTurn.spanId);
    expect(sideChildren).toHaveLength(4); // 3 LLM + 1 Glob tool
  });

  it('marks the sidechain root with joinQuality=heuristic and agent attrs', () => {
    const sideTurn = one(
      result.spans,
      (s) => s.kind === 'AGENT_TURN' && s.attributes[ATTR.AGENT_ID] === SUB_AGENT_ID,
      'sidechain turn',
    );
    expect(sideTurn.attributes[ATTR.JOIN_QUALITY]).toBe('heuristic');
    expect(sideTurn.attributes[ATTR.AGENT_PARENT_ID]).toBe('main');
    expect(sideTurn.attributes['agent.name']).toBe('Explore');
    expect(sideTurn.agentName).toBe('Explore');
    expect(sideTurn.attributes[ATTR.DETACHED]).toBeUndefined();
    // the Task tool_result is the observed end of a synchronous subagent
    expect(sideTurn.attributes[ATTR.INCOMPLETE]).toBeUndefined();
    expect(sideTurn.durationMs).toBe(4000); // 6000 - 2000
    expect(sideTurn.attributes['turn.rowCount']).toBe(5);
  });

  it('closes the Task span on its tool_result', () => {
    const task = one(result.spans, (s) => s.toolName === 'Task', 'task span');
    expect(task.durationMs).toBe(5000); // 6000 - 1000
    expect(task.outputSummary).toBe('explored 3 adapters');
  });

  it('matches the snapshot', () => {
    expect(treeView(result.spans)).toMatchSnapshot();
  });

  it('is idempotent across re-runs (same spanId set, stable store counts)', () => {
    const first = result.spans.map((s) => s.spanId).sort();
    return run(SUB_SESSION).then((again) => {
      expect(again.spans.map((s) => s.spanId).sort()).toEqual(first);
      store.insertSpans(result.spans);
      store.insertSpans(again.spans);
      expect(store.getStats(SUB_SESSION).spanCount).toBe(10);
    });
  });
});

describe('parse: subagent spawned via Agent tool (heuristic join)', () => {
  let result: HarnessResult;
  beforeAll(async () => {
    result = await run(AGENT_TOOL_SESSION);
  });

  it('wires the sidechain root under the Agent tool_use span', () => {
    const agent = one(result.spans, (s) => s.toolName === 'Agent', 'agent tool span');
    const sideTurn = one(
      result.spans,
      (s) => s.kind === 'AGENT_TURN' && s.attributes[ATTR.AGENT_ID] === AGENT_TOOL_AGENT_ID,
      'sidechain turn',
    );
    expect(sideTurn.parentSpanId).toBe(agent.spanId);
    expect(sideTurn.attributes[ATTR.JOIN_QUALITY]).toBe('heuristic');
    expect(sideTurn.attributes['agent.name']).toBe('general-purpose');
  });
});

describe('parse: interrupted session', () => {
  it('leaves dangling turn/tool spans to closeAllIncomplete', async () => {
    const result = await run(INT_SESSION);
    expect(result.spans).toHaveLength(4);
    const session = one(result.spans, (s) => s.kind === 'SESSION', 'session');
    const llm = one(result.spans, (s) => s.kind === 'LLM_CALL', 'llm');
    const turn = one(result.spans, (s) => s.kind === 'AGENT_TURN', 'turn');
    const tool = one(result.spans, (s) => s.kind === 'TOOL_CALL', 'tool');
    expect(session.attributes[ATTR.INCOMPLETE]).toBeUndefined();
    expect(llm.attributes[ATTR.INCOMPLETE]).toBeUndefined();
    expect(turn.attributes[ATTR.INCOMPLETE]).toBe(true);
    expect(tool.attributes[ATTR.INCOMPLETE]).toBe(true);
    // incomplete duration = lastSeen - start
    expect(turn.durationMs).toBe(1000);
    expect(tool.durationMs).toBe(0);
  });
});

describe('parse: joins.jsonl sidecar (structural join)', () => {
  it('wires the sidechain root to the Task span with joinQuality=structural', async () => {
    const result = await run(JOIN_SESSION);
    const task = one(result.spans, (s) => s.toolName === 'Task', 'task span');
    const sideTurn = one(
      result.spans,
      (s) => s.kind === 'AGENT_TURN' && s.attributes[ATTR.AGENT_ID] === JOIN_AGENT_ID,
      'sidechain turn',
    );
    expect(sideTurn.parentSpanId).toBe(task.spanId);
    expect(sideTurn.attributes[ATTR.JOIN_QUALITY]).toBe('structural');
    expect(sideTurn.attributes['agent.name']).toBe(JOIN_AGENT_ID); // no meta file: fall back to id
  });
});

describe('parse: orphan subagent (no tier matches)', () => {
  it('emits sidechain spans without parentSpanId or joinQuality', async () => {
    const result = await run(ORPHAN_SESSION);
    expect(result.spans).toHaveLength(5);
    const sideTurn = one(
      result.spans,
      (s) => s.kind === 'AGENT_TURN' && s.attributes[ATTR.AGENT_ID] === ORPHAN_AGENT_ID,
      'orphan turn',
    );
    expect(sideTurn.parentSpanId).toBeUndefined();
    expect(sideTurn.attributes[ATTR.JOIN_QUALITY]).toBeUndefined();
    expect(sideTurn.attributes[ATTR.AGENT_PARENT_ID]).toBeUndefined();
    const sideLlm = one(
      result.spans,
      (s) => s.kind === 'LLM_CALL' && s.attributes[ATTR.AGENT_ID] === ORPHAN_AGENT_ID,
      'orphan llm',
    );
    expect(sideLlm.parentSpanId).toBe(sideTurn.spanId);
  });
});

describe('parse: fromOffset resume', () => {
  it('emits nothing when the offset reaches EOF', async () => {
    const ref = sessions.get(SIMPLE_SESSION)!;
    const result = await run(SIMPLE_SESSION, ref.size);
    expect(result.spans).toHaveLength(0);
    expect(result.meta).toBeUndefined();
  });

  it('resumes at the first complete record at/after the offset', async () => {
    const ref = sessions.get(SIMPLE_SESSION)!;
    const partial = await run(SIMPLE_SESSION, 10); // lands inside line 1
    // line 1 (user prompt) is skipped as partial; later rows still parse
    expect(partial.spans.length).toBeGreaterThan(0);
    const rowKeys = partial.spans.map((s) => s.spanId);
    const full = await run(SIMPLE_SESSION);
    for (const id of rowKeys) {
      expect(full.spans.map((s) => s.spanId)).toContain(id);
    }
  });
});
