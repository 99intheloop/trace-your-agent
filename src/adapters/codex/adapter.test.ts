import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { traceIdFor } from '../../core/ids.js';
import { IngestPipeline } from '../../core/ingest.js';
import { OffsetStore } from '../../core/offsets.js';
import type { RawEvent, SessionRef } from '../../core/source.js';
import { ATTR, type Span } from '../../core/types.js';
import { TraceStore } from '../../store/store.js';
import { CodexAdapter } from './adapter.js';
import * as fx from './fixtures.js';
import { findSpan, runEvents, spanForest } from '../testkit.js';

/** Write one rollout file under <home>/sessions/2026/06/18/. Returns its path. */
function writeThread(home: string, threadId: string, lines: unknown[]): string {
  const dir = join(home, 'sessions', '2026', '06', '18');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, fx.rolloutFileName(threadId));
  writeFileSync(filePath, fx.toJsonl(lines), 'utf8');
  return filePath;
}

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'tya-codex-'));
}

async function collect(iter: AsyncIterable<RawEvent>): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

async function discoverAll(adapter: CodexAdapter): Promise<SessionRef[]> {
  const home = await adapter.detect();
  if (home === null) throw new Error('detect returned null');
  const refs: SessionRef[] = [];
  for await (const ref of adapter.discover(home)) refs.push(ref);
  return refs;
}

async function ingest(adapter: CodexAdapter, ref: SessionRef, fromOffset = 0) {
  const events = await collect(adapter.parse(ref, fromOffset));
  return runEvents(events, traceIdFor('codex', ref.sessionId));
}

function refFor(filePath: string, sessionId: string): SessionRef {
  return { source: 'codex', sessionId, filePath, mtime: 0, size: 0 };
}

describe('detect', () => {
  it('returns null when ~/.codex is absent', async () => {
    const adapter = new CodexAdapter({ homeDir: join(makeHome(), 'nope') });
    expect(await adapter.detect()).toBeNull();
  });

  it('reports home, readability, and the most common cli_version', async () => {
    const home = makeHome();
    writeThread(home, fx.ROOT_ID, fx.singleThreadLines(fx.ROOT_ID));
    writeThread(home, fx.CHILD_ID, fx.abortedThreadLines(fx.CHILD_ID));
    const adapter = new CodexAdapter({ homeDir: home });
    const detected = await adapter.detect();
    expect(detected).not.toBeNull();
    expect(detected?.homeDir).toBe(home);
    expect(detected?.readable).toBe(true);
    expect(detected?.version).toBe('0.55.0');

    const stats = await adapter.collectStats(detected!);
    expect(stats.rolloutFileCount).toBe(2);
    expect(stats.cliVersions).toEqual({ '0.55.0': 2 });
  });
});

describe('discover', () => {
  it('groups rollout files into thread trees (one SessionRef per tree)', async () => {
    const home = makeHome();
    const tree = fx.twoThreadTree({ collab: true });
    writeThread(home, fx.ROOT_ID, tree.parent);
    writeThread(home, fx.CHILD_ID, tree.child);
    writeThread(home, fx.FORK_ID, fx.forkedThreadLines(fx.FORK_ID, fx.ROOT_ID));
    writeThread(home, fx.ORPHAN_ID, [
      fx.sessionMetaLine(fx.ORPHAN_ID, { parentThreadId: '99999999-9999-4999-8999-999999999999' }),
    ]);

    const refs = await discoverAll(new CodexAdapter({ homeDir: home }));
    const byId = new Map(refs.map((r) => [r.sessionId, r]));
    // Two trees: ROOT (root + spawn child + fork child) and ORPHAN (parent missing).
    expect([...byId.keys()].sort()).toEqual([fx.ORPHAN_ID, fx.ROOT_ID].sort());
    const root = byId.get(fx.ROOT_ID);
    expect(root?.filePath).toContain(fx.ROOT_ID);
    expect(root?.mtime).toBeGreaterThan(0);
    expect(root?.size).toBeGreaterThan(0);
  });
});

describe('parse — single thread (phase A)', () => {
  it('normalizes session/turn/tool/approx-LLM spans with usage backfill', async () => {
    const home = makeHome();
    const filePath = writeThread(home, fx.ROOT_ID, fx.singleThreadLines(fx.ROOT_ID));
    const adapter = new CodexAdapter({ homeDir: home });
    const { spans } = await ingest(adapter, refFor(filePath, fx.ROOT_ID));

    const session = findSpan(spans, 'SESSION');
    expect(session.attributes[ATTR.SESSION_ID]).toBe(fx.ROOT_ID);
    expect(session.attributes[ATTR.SOURCE]).toBe('codex');
    expect(session.attributes['codex.cliVersion']).toBe('0.55.0');
    expect(session.attributes['gen_ai.provider.name']).toBe('openai');
    // No session-end record exists: closed by EOF cleanup.
    expect(session.attributes[ATTR.INCOMPLETE]).toBe(true);

    const turn = findSpan(spans, 'AGENT_TURN');
    expect(turn.status.code).toBe('ok');
    expect(turn.parentSpanId).toBe(session.spanId);
    expect(turn.outputSummary).toBe('tests are green now');
    // Both token_count events accumulate onto the turn.
    expect(turn.tokenUsage).toEqual({
      inputTokens: 2700,
      outputTokens: 120,
      cacheReadTokens: 600,
    });

    const tool = findSpan(spans, 'TOOL_CALL', 'exec_command');
    expect(tool.inputSummary).toBe('{"cmd":"npm test"}');
    expect(tool.outputSummary).toBe('3 passed, 0 failed');
    expect(tool.status.code).toBe('ok');

    const llms = spans.filter((s) => s.kind === 'LLM_CALL');
    expect(llms).toHaveLength(2);
    for (const llm of llms) {
      expect(llm.attributes[ATTR.APPROX]).toBe(true);
      expect(llm.attributes[ATTR.GEN_AI_MODEL]).toBe('gpt-5.1-codex');
    }
    // The tool call belongs to the first (approximated) model-request segment.
    expect(tool.parentSpanId).toBe(llms[0]?.spanId);
    expect(llms[0]?.tokenUsage).toEqual({
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 300,
    });
    expect(llms[1]?.tokenUsage).toEqual({
      inputTokens: 1500,
      outputTokens: 40,
      cacheReadTokens: 300,
    });

    expect(spanForest(spans)).toMatchSnapshot();
  });

  it('is idempotent: re-parsing yields identical span ids', async () => {
    const home = makeHome();
    const filePath = writeThread(home, fx.ROOT_ID, fx.singleThreadLines(fx.ROOT_ID));
    const adapter = new CodexAdapter({ homeDir: home });
    const ref = refFor(filePath, fx.ROOT_ID);
    const first = await ingest(adapter, ref);
    const second = await ingest(adapter, ref);
    expect(first.spans).toEqual(second.spans);
    expect(first.links).toEqual(second.links);
  });

  it('resumes from a byte offset without re-emitting earlier rows', async () => {
    const home = makeHome();
    const filePath = writeThread(home, fx.ROOT_ID, fx.singleThreadLines(fx.ROOT_ID));
    const adapter = new CodexAdapter({ homeDir: home });
    const ref = refFor(filePath, fx.ROOT_ID);

    const full = await ingest(adapter, ref);

    // Offset = start of the token_count line (line 7, 0-based): everything
    // before it (turn, user input, reasoning, function_call) is skipped.
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n');
    let offset = 0;
    for (let i = 0; i < 7; i += 1) offset += Buffer.byteLength(lines[i] ?? '', 'utf8') + 1;

    const resumed = await ingest(adapter, ref, offset);
    const fullIds = new Set(full.spans.map((s) => s.spanId));
    // No AGENT_TURN / TOOL_CALL from before the offset; SESSION re-emitted with
    // the same deterministic id.
    expect(resumed.spans.find((s) => s.kind === 'AGENT_TURN')).toBeUndefined();
    expect(resumed.spans.find((s) => s.kind === 'TOOL_CALL')).toBeUndefined();
    const session = findSpan(resumed.spans, 'SESSION');
    expect(fullIds.has(session.spanId)).toBe(true);
    for (const span of resumed.spans) expect(fullIds.has(span.spanId)).toBe(true);
  });

  it('marks aborted turns as errors', async () => {
    const home = makeHome();
    const filePath = writeThread(home, fx.ROOT_ID, fx.abortedThreadLines(fx.ROOT_ID));
    const { spans } = await ingest(new CodexAdapter({ homeDir: home }), refFor(filePath, fx.ROOT_ID));
    const turn = findSpan(spans, 'AGENT_TURN');
    expect(turn.status.code).toBe('error');
    expect(turn.status.message).toBe('turn_aborted: interrupted');
  });
});

describe('parse — thread tree (phase B)', () => {
  async function ingestTree(options: fx.TreeFixtureOptions) {
    const home = makeHome();
    const tree = fx.twoThreadTree(options);
    writeThread(home, tree.parentId, tree.parent);
    writeThread(home, tree.childId, tree.child);
    const adapter = new CodexAdapter({ homeDir: home });
    const refs = await discoverAll(adapter);
    const root = refs.find((r) => r.sessionId === tree.parentId);
    if (root === undefined) throw new Error('root SessionRef not found');
    const result = await ingest(adapter, root);
    return { ...result, tree };
  }

  function childSession(spans: Span[], tree: { childId: string }): Span {
    const found = spans.find(
      (s) => s.kind === 'SESSION' && s.attributes[ATTR.AGENT_ID] === tree.childId,
    );
    if (found === undefined) throw new Error('child SESSION span not found');
    return found;
  }

  it('structural join: collab_agent_spawn_end names the child thread', async () => {
    const { spans, links, tree } = await ingestTree({ collab: true });
    const spawnTool = findSpan(spans, 'TOOL_CALL', 'spawn_agent');
    const child = childSession(spans, tree);

    expect(child.parentSpanId).toBe(spawnTool.spanId);
    expect(child.attributes[ATTR.JOIN_QUALITY]).toBe('structural');
    expect(child.attributes[ATTR.SESSION_ID]).toBe(tree.parentId);
    expect(child.attributes[ATTR.AGENT_PARENT_ID]).toBe(tree.parentId);
    expect(child.agentName).toBe('Newton');
    expect(child.attributes[ATTR.DETACHED]).toBeUndefined();
    expect(spawnTool.attributes[ATTR.AGENT_SPAWN_CHILD_AGENT_ID]).toBe(tree.childId);
    expect(links).toEqual([]);

    // Child turn hangs under the child session; whole forest has one root.
    const childTurn = spans.find(
      (s) => s.kind === 'AGENT_TURN' && s.parentSpanId === child.spanId,
    );
    expect(childTurn).toBeDefined();
    const forest = spanForest(spans);
    expect(forest).toHaveLength(1);
    expect(forest).toMatchSnapshot();
  });

  it('semi join: spawn output carries the child agent id', async () => {
    const { spans, tree } = await ingestTree({ collab: false });
    const spawnTool = findSpan(spans, 'TOOL_CALL', 'spawn_agent');
    const child = childSession(spans, tree);
    expect(child.parentSpanId).toBe(spawnTool.spanId);
    expect(child.attributes[ATTR.JOIN_QUALITY]).toBe('semi');
  });

  it('heuristic join: only a time-nearest spawn call to go on', async () => {
    const { spans, tree } = await ingestTree({ collab: false, anonymousSpawn: true });
    const spawnTool = findSpan(spans, 'TOOL_CALL', 'spawn_agent');
    const child = childSession(spans, tree);
    expect(child.parentSpanId).toBe(spawnTool.spanId);
    expect(child.attributes[ATTR.JOIN_QUALITY]).toBe('heuristic');
  });

  it('async spawn: detached + NOTIFY link; sync spawn: neither', async () => {
    const detached = await ingestTree({ wait: false, parentContinues: true });
    const child = childSession(detached.spans, detached.tree);
    const spawnTool = findSpan(detached.spans, 'TOOL_CALL', 'spawn_agent');
    expect(child.attributes[ATTR.DETACHED]).toBe(true);
    expect(detached.links).toEqual([
      { fromSpanId: spawnTool.spanId, toSpanId: child.spanId, kind: 'NOTIFY' },
    ]);

    const sync = await ingestTree({ wait: true, parentContinues: true });
    const syncChild = childSession(sync.spans, sync.tree);
    expect(syncChild.attributes[ATTR.DETACHED]).toBeUndefined();
    expect(sync.links).toEqual([]);
  });

  it('forked threads attach under the origin session (heuristic)', async () => {
    const home = makeHome();
    writeThread(home, fx.ROOT_ID, fx.singleThreadLines(fx.ROOT_ID));
    writeThread(home, fx.FORK_ID, fx.forkedThreadLines(fx.FORK_ID, fx.ROOT_ID));
    const adapter = new CodexAdapter({ homeDir: home });
    const refs = await discoverAll(adapter);
    expect(refs.map((r) => r.sessionId)).toEqual([fx.ROOT_ID]);
    const { spans } = await ingest(adapter, refs[0]!);

    const rootSession = spans.find(
      (s) => s.kind === 'SESSION' && s.attributes[ATTR.AGENT_ID] === fx.ROOT_ID,
    );
    const fork = spans.find(
      (s) => s.kind === 'SESSION' && s.attributes[ATTR.AGENT_ID] === fx.FORK_ID,
    );
    expect(rootSession).toBeDefined();
    expect(fork?.parentSpanId).toBe(rootSession?.spanId);
    expect(fork?.attributes[ATTR.JOIN_QUALITY]).toBe('heuristic');
    expect(fork?.attributes['codex.forkedFrom']).toBe(fx.ROOT_ID);
  });

  it('orphan threads (parent file missing) stay root spans', async () => {
    const home = makeHome();
    writeThread(home, fx.ORPHAN_ID, [
      fx.sessionMetaLine(fx.ORPHAN_ID, { parentThreadId: '99999999-9999-4999-8999-999999999999' }),
      fx.taskStarted(100, 't1'),
      fx.taskComplete(200, 't1', 'done'),
    ]);
    const adapter = new CodexAdapter({ homeDir: home });
    const refs = await discoverAll(adapter);
    expect(refs).toHaveLength(1);
    const { spans } = await ingest(adapter, refs[0]!);
    const session = findSpan(spans, 'SESSION');
    expect(session.parentSpanId).toBeUndefined();
    expect(session.attributes[ATTR.JOIN_QUALITY]).toBeUndefined();
  });
});

describe('store integration', () => {
  it('aggregates a whole thread tree under one session.id', async () => {
    const home = makeHome();
    const tree = fx.twoThreadTree({ collab: true });
    writeThread(home, tree.parentId, tree.parent);
    writeThread(home, tree.childId, tree.child);
    const adapter = new CodexAdapter({ homeDir: home });
    const refs = await discoverAll(adapter);
    const { spans, links } = await ingest(adapter, refs[0]!);

    const store = new TraceStore(':memory:');
    try {
      store.insertSpans(spans);
      store.insertLinks(links);
      const row = store.getSessionRow(tree.parentId);
      expect(row).toBeDefined();
      expect(row?.source).toBe('codex');
      expect(row?.spanCount).toBe(spans.length);
      expect(row?.agentCount).toBe(2);
      expect(row?.turnCount).toBe(2);
      expect(row?.totalInputTokens).toBe(500);
      expect(row?.totalOutputTokens).toBe(20);
      expect(row?.joinQualityStats['structural']).toBe(1);
      // Idempotent re-insert.
      store.insertSpans(spans);
      expect(store.getSessionRow(tree.parentId)?.spanCount).toBe(spans.length);
    } finally {
      store.close();
    }
  });

  it('runs end-to-end through the real IngestPipeline with zero warnings', async () => {
    const home = makeHome();
    const tree = fx.twoThreadTree({ collab: true });
    writeThread(home, tree.parentId, tree.parent);
    writeThread(home, tree.childId, tree.child);

    const tyaHome = makeHome();
    const store = new TraceStore(':memory:');
    try {
      const pipeline = new IngestPipeline({ store, offsets: new OffsetStore(tyaHome) });
      const adapter = new CodexAdapter({ homeDir: home });
      const report = await pipeline.ingestAdapter(adapter);
      expect(report.filesProcessed).toBe(1);
      expect(report.errors).toBe(0);
      expect(report.warnings).toBe(0);
      expect(report.spansWritten).toBeGreaterThan(0);

      const row = store.getSessionRow(tree.parentId);
      expect(row?.agentCount).toBe(2);
      expect(row?.turnCount).toBe(2);

      // Second run: cursors say nothing changed → no re-parse, no duplicates.
      const second = await pipeline.ingestAdapter(adapter);
      expect(second.filesProcessed).toBe(0);
      expect(store.getSessionRow(tree.parentId)?.spanCount).toBe(row?.spanCount);
    } finally {
      store.close();
    }
  });
});
