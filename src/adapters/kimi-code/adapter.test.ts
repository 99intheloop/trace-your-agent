import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { traceIdFor } from '../../core/ids.js';
import type { RawEvent, SessionRef } from '../../core/source.js';
import { ATTR, type Span } from '../../core/types.js';
import { findSpan, runEvents, spanForest } from '../testkit.js';
import { KimiCodeAdapter, resolveKimiHome } from './adapter.js';
import { UnknownWireProtocolError } from './wire.js';

// ---------------------------------------------------------------------------
// Fixture builders — layout per FORMAT.md §1:
//   <home>/sessions/<workspace>/<sessionId>/state.json
//   <home>/sessions/<workspace>/<sessionId>/agents/<agentId>/wire.jsonl
// ---------------------------------------------------------------------------

const T0 = 1_752_000_000_000; // fixed epoch ms for determinism

function wireLine(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function metadataLine(protocolVersion: string): string {
  return wireLine({ type: 'metadata', protocol_version: protocolVersion, created_at: T0 });
}

/** Write one session dir. wires: agentId → wire.jsonl content lines (without metadata). */
function writeSession(
  home: string,
  sessionId: string,
  state: Record<string, unknown>,
  wires: Record<string, { protocol: string; lines: Record<string, unknown>[] }>,
): string {
  const sessionDir = join(home, 'sessions', 'wk-test', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify(state), 'utf8');
  for (const [agentId, wire] of Object.entries(wires)) {
    const agentDir = join(sessionDir, 'agents', agentId);
    mkdirSync(agentDir, { recursive: true });
    const content = [metadataLine(wire.protocol), ...wire.lines.map(wireLine)].join('\n') + '\n';
    writeFileSync(join(agentDir, 'wire.jsonl'), content, 'utf8');
  }
  return sessionDir;
}

/** A v1-style single-agent turn: prompt → step (tool call) → step (final text). */
function v1MainLines(): Record<string, unknown>[] {
  return [
    { type: 'turn.prompt', time: T0 + 1000, turnId: 0, input: 'hello', origin: { kind: 'user' } },
    { type: 'context.append_loop_event', time: T0 + 1100, event: { type: 'step.begin', uuid: 's1', step: 1, turnId: 't0' } },
    { type: 'llm.request', time: T0 + 1150, provider: 'kimi', model: 'kimi-k2', turnStep: 1, attempt: 1, messageCount: 3 },
    { type: 'context.append_loop_event', time: T0 + 1200, event: { type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'let me read it' } } },
    { type: 'context.append_loop_event', time: T0 + 1300, event: { type: 'tool.call', uuid: 'tc1', toolCallId: 'call-1', name: 'Read', args: { path: '/tmp/a.txt' }, stepUuid: 's1' } },
    { type: 'context.append_loop_event', time: T0 + 1400, event: { type: 'step.end', uuid: 's1', finishReason: 'tool_use', llmFirstTokenLatencyMs: 80, llmStreamDurationMs: 400, usage: { inputOther: 100, output: 20 } } },
    { type: 'context.append_loop_event', time: T0 + 1500, event: { type: 'tool.result', uuid: 'tr1', toolCallId: 'call-1', result: { output: 'file contents' } } },
    { type: 'context.append_loop_event', time: T0 + 1600, event: { type: 'step.begin', uuid: 's2', step: 2, turnId: 't0' } },
    { type: 'context.append_loop_event', time: T0 + 1700, event: { type: 'content.part', stepUuid: 's2', part: { type: 'text', text: 'done' } } },
    { type: 'context.append_loop_event', time: T0 + 1800, event: { type: 'step.end', uuid: 's2', finishReason: 'stop', llmFirstTokenLatencyMs: 60, llmServerFirstTokenMs: 40, llmServerDecodeMs: 300, usage: { inputOther: 150, output: 30 } } },
  ];
}

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'tya-kimi-'));
}

async function collect(iter: AsyncIterable<RawEvent>): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

function adapterFor(home: string): KimiCodeAdapter {
  return new KimiCodeAdapter({ env: { KIMI_CODE_HOME: home } });
}

async function ingestSession(home: string, sessionId: string) {
  const adapter = adapterFor(home);
  const detected = await adapter.detect();
  if (detected === null) throw new Error('detect returned null');
  const refs: SessionRef[] = [];
  for await (const ref of adapter.discover(detected)) refs.push(ref);
  const ref = refs.find((r) => r.sessionId === sessionId);
  if (ref === undefined) throw new Error(`session not discovered: ${sessionId}`);
  const events = await collect(adapter.parse(ref, 0));
  return { events, result: runEvents(events, traceIdFor('kimi-code', sessionId)) };
}

describe('resolveKimiHome', () => {
  it('honors KIMI_CODE_HOME override', () => {
    expect(resolveKimiHome({ KIMI_CODE_HOME: '/tmp/kh' })).toBe('/tmp/kh');
  });
});

describe('detect + discover', () => {
  it('returns null when the home is absent', async () => {
    const adapter = adapterFor(join(makeHome(), 'nope'));
    expect(await adapter.detect()).toBeNull();
  });

  it('discovers one SessionRef per session directory', async () => {
    const home = makeHome();
    writeSession(home, 'sess-1', { workDir: '/tmp/x', createdAt: new Date(T0).toISOString(), agents: { main: {} } }, {
      main: { protocol: '1.4', lines: v1MainLines() },
    });
    const adapter = adapterFor(home);
    const detected = await adapter.detect();
    expect(detected).not.toBeNull();
    expect(detected?.version).toContain('1.4');
    const refs: SessionRef[] = [];
    for await (const ref of adapter.discover(detected!)) refs.push(ref);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.sessionId).toBe('sess-1');
    expect(refs[0]?.filePath.endsWith(join('agents', 'main', 'wire.jsonl'))).toBe(true);
  });
});

describe('parse — v1 single-agent session', () => {
  it('builds SESSION → AGENT_TURN → LLM_CALL/TOOL_CALL with latency events and usage', async () => {
    const home = makeHome();
    writeSession(home, 'sess-v1', { workDir: '/tmp/x', createdAt: new Date(T0).toISOString(), agents: { main: {} } }, {
      main: { protocol: '1.4', lines: v1MainLines() },
    });
    const { result } = await ingestSession(home, 'sess-v1');
    const { spans } = result;

    const session = findSpan(spans, 'SESSION');
    expect(session.attributes[ATTR.SOURCE]).toBe('kimi-code');

    const turn = findSpan(spans, 'AGENT_TURN');
    expect(turn.parentSpanId).toBe(session.spanId);
    expect(turn.status.code).toBe('ok');

    const llmCalls = spans.filter((s) => s.kind === 'LLM_CALL');
    expect(llmCalls).toHaveLength(2);
    const s2 = llmCalls.find((s) => s.tokenUsage?.inputTokens === 150);
    expect(s2).toBeDefined();
    expect(s2?.tokenUsage?.outputTokens).toBe(30);
    // Precise latency split is the kimi wire's unique strength — must land on the span.
    const eventNames = (s2?.events ?? []).map((e) => e.name);
    expect(eventNames.some((n) => n.includes('first_token') || n.includes('firstToken'))).toBe(true);

    const tool = findSpan(spans, 'TOOL_CALL', 'Read');
    expect(tool.status.code).toBe('ok');
    expect(tool.durationMs).toBeGreaterThan(0);

    // Tree sanity: llm calls sit under the turn; tool calls nest inside steps.
    const forest = spanForest(spans);
    expect(forest).toHaveLength(1);
    const turnNode = forest[0]?.children.find((c) => c.kind === 'AGENT_TURN');
    const llmNodes = turnNode?.children.filter((c) => c.kind === 'LLM_CALL') ?? [];
    expect(llmNodes).toHaveLength(2);
    expect(llmNodes.some((n) => n.children.some((c) => c.kind === 'TOOL_CALL'))).toBe(true);
  });

  it('is idempotent across re-parses', async () => {
    const home = makeHome();
    writeSession(home, 'sess-idem', { workDir: '/tmp/x', createdAt: new Date(T0).toISOString(), agents: { main: {} } }, {
      main: { protocol: '1.4', lines: v1MainLines() },
    });
    const first = (await ingestSession(home, 'sess-idem')).result.spans.map((s) => s.spanId).sort();
    const second = (await ingestSession(home, 'sess-idem')).result.spans.map((s) => s.spanId).sort();
    expect(second).toEqual(first);
  });
});

describe('parse — parent/child join', () => {
  it('attaches a subagent turn under the Agent tool call with joinQuality', async () => {
    const home = makeHome();
    const mainLines: Record<string, unknown>[] = [
      { type: 'turn.prompt', time: T0 + 1000, turnId: 0, input: 'do the task', origin: { kind: 'user' } },
      { type: 'context.append_loop_event', time: T0 + 1100, event: { type: 'step.begin', uuid: 's1', step: 1, turnId: 't0' } },
      { type: 'context.append_loop_event', time: T0 + 1200, event: { type: 'tool.call', uuid: 'tc1', toolCallId: 'spawn-1', name: 'Agent', args: { prompt: 'do x', subagent_type: 'coder' }, stepUuid: 's1' } },
      { type: 'context.append_loop_event', time: T0 + 5000, event: { type: 'tool.result', uuid: 'tr1', toolCallId: 'spawn-1', result: { output: 'Subagent finished. agent_id: agent-0' } } },
      { type: 'context.append_loop_event', time: T0 + 5100, event: { type: 'step.end', uuid: 's1', finishReason: 'stop', usage: { inputOther: 10, output: 5 } } },
    ];
    const childLines: Record<string, unknown>[] = [
      { type: 'turn.prompt', time: T0 + 2000, turnId: 0, input: 'do x', origin: { kind: 'system_trigger', name: 'subagent' } },
      { type: 'context.append_loop_event', time: T0 + 2100, event: { type: 'step.begin', uuid: 'c1', step: 1, turnId: 'ct0' } },
      { type: 'context.append_loop_event', time: T0 + 2200, event: { type: 'content.part', stepUuid: 'c1', part: { type: 'text', text: 'child answer' } } },
      { type: 'context.append_loop_event', time: T0 + 2300, event: { type: 'step.end', uuid: 'c1', finishReason: 'stop', usage: { inputOther: 50, output: 10 } } },
    ];
    writeSession(
      home,
      'sess-join',
      { version: 2, cwd: '/tmp/x', createdAt: T0, agents: { main: {}, 'agent-0': { parentAgentId: 'main' } } },
      {
        main: { protocol: '1.5', lines: mainLines },
        'agent-0': { protocol: '1.5', lines: childLines },
      },
    );
    const { result } = await ingestSession(home, 'sess-join');
    const spans: Span[] = result.spans;

    const spawnTool = findSpan(spans, 'TOOL_CALL', 'Agent');
    const childTurn = spans.find(
      (s) => s.kind === 'AGENT_TURN' && s.attributes[ATTR.AGENT_ID] === 'agent-0',
    );
    expect(childTurn).toBeDefined();
    expect(childTurn?.parentSpanId).toBe(spawnTool.spanId);
    expect(childTurn?.attributes[ATTR.JOIN_QUALITY]).toBeDefined();
  });
});

describe('parse — protocol guard', () => {
  it('throws UnknownWireProtocolError for out-of-lineage versions', async () => {
    const home = makeHome();
    writeSession(home, 'sess-bad', { workDir: '/tmp/x', agents: { main: {} } }, {
      main: { protocol: '9.9', lines: [{ type: 'turn.prompt', time: T0, input: 'x' }] },
    });
    await expect(ingestSession(home, 'sess-bad')).rejects.toBeInstanceOf(UnknownWireProtocolError);
  });
});
