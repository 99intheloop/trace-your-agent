import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceStore } from '../store/store.js';
import { IngestPipeline, emptyIngestReport, type IngestReport } from './ingest.js';
import { OffsetStore } from './offsets.js';
import { PayloadStore } from './payload-store.js';
import type { Adapter, RawEvent, SessionRef } from './source.js';
import { ATTR, type Span } from './types.js';

let dir: string;
let store: TraceStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tya-ingest-'));
  store = new TraceStore(':memory:');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeRef(overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    source: 'claude-code',
    sessionId: 'sess-1',
    filePath: '/fake/sess-1.jsonl',
    mtime: 1000,
    size: 500,
    ...overrides,
  };
}

function mockAdapter(
  events: readonly RawEvent[],
  refs: readonly SessionRef[] = [makeRef()],
): Adapter {
  return {
    source: 'claude-code',
    detect: async () => ({ source: 'claude-code', homeDir: '/fake', readable: true }),
    discover: async function* () {
      for (const ref of refs) yield ref;
    },
    parse: async function* () {
      for (const event of events) yield event;
    },
  };
}

function makePipeline(offsets: OffsetStore): IngestPipeline {
  return new IngestPipeline({ store, offsets, payloads: new PayloadStore(dir) });
}

const SIMPLE_EVENTS: RawEvent[] = [
  { type: 'session.meta', cwd: '/repo', startedAtMs: 1000 },
  {
    type: 'span.open',
    key: 's',
    sourceRowKey: 'row-1',
    kind: 'SESSION',
    name: 'session',
    startTimeMs: 1000,
  },
  {
    type: 'span.open',
    key: 't1',
    parentKey: 's',
    sourceRowKey: 'row-2',
    kind: 'AGENT_TURN',
    name: 'turn 1',
    startTimeMs: 1100,
  },
  {
    type: 'span.close',
    key: 't1',
    endTimeMs: 1500,
    tokenUsage: { inputTokens: 10, outputTokens: 5 },
    outputSummary: 'done',
  },
  { type: 'span.close', key: 's', endTimeMs: 1600 },
];

describe('IngestPipeline', () => {
  it('ingests a simple session: spans, parent wiring, session meta', async () => {
    const pipeline = makePipeline(new OffsetStore(dir));
    const report = await pipeline.ingestAdapter(mockAdapter(SIMPLE_EVENTS));

    expect(report).toMatchObject({
      filesProcessed: 1,
      spansWritten: 2,
      linksWritten: 0,
      warnings: 0,
      errors: 0,
    });

    const spans = store.getSessionSpans('sess-1');
    expect(spans).toHaveLength(2);
    const [sessionSpan, turnSpan] = spans;
    expect(sessionSpan?.kind).toBe('SESSION');
    expect(sessionSpan?.parentSpanId).toBeUndefined();
    expect(sessionSpan?.durationMs).toBe(600);
    expect(turnSpan?.parentSpanId).toBe(sessionSpan?.spanId);
    expect(turnSpan?.tokenUsage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(turnSpan?.attributes[ATTR.SESSION_ID]).toBe('sess-1');
    expect(turnSpan?.attributes[ATTR.SOURCE]).toBe('claude-code');

    const row = store.getSessionRow('sess-1');
    expect(row?.cwd).toBe('/repo');
    expect(row?.spanCount).toBe(2);
    expect(row?.turnCount).toBe(1);
  });

  it('is idempotent: re-ingesting the same offset range never duplicates spans', async () => {
    const offsets = new OffsetStore(dir);
    const pipeline = makePipeline(offsets);
    const adapter = mockAdapter(SIMPLE_EVENTS);

    await pipeline.ingestAdapter(adapter);
    // Second run with an unchanged file: skipped entirely via the cursor.
    const second = await pipeline.ingestAdapter(adapter);
    expect(second.filesProcessed).toBe(0);
    expect(second.spansWritten).toBe(0);
    expect(store.getSessionSpans('sess-1')).toHaveLength(2);

    // Forced re-parse of the same range (cursor lost): spans are rewritten
    // with the same deterministic ids, so the store still holds exactly 2.
    offsets.reset();
    const third = await pipeline.ingestAdapter(adapter);
    expect(third.filesProcessed).toBe(1);
    expect(third.spansWritten).toBe(2);
    expect(store.getSessionSpans('sess-1')).toHaveLength(2);
  });

  it('writes the offset cursor only for fully processed files', async () => {
    const offsets = new OffsetStore(dir);
    const pipeline = makePipeline(offsets);
    await pipeline.ingestAdapter(mockAdapter(SIMPLE_EVENTS));
    expect(offsets.get('/fake/sess-1.jsonl')).toEqual({ offset: 500, mtime: 1000, size: 500 });
  });

  it('tolerates bad events: counts warnings and keeps going', async () => {
    const events: RawEvent[] = [
      { type: 'span.open', key: 'a', sourceRowKey: 'r1', kind: 'SESSION', name: 's', startTimeMs: 1 },
      // Duplicate open of the same key -> SpanBuilder throws -> warning.
      { type: 'span.open', key: 'a', sourceRowKey: 'r2', kind: 'SESSION', name: 's2', startTimeMs: 2 },
      // Close of a key that is not open -> warning.
      { type: 'span.close', key: 'nope', endTimeMs: 3 },
      // attr/event on a missing key -> warnings.
      { type: 'span.attr', key: 'ghost', attributes: { x: 1 } },
      { type: 'span.event', key: 'ghost', event: { name: 'e', timestampMs: 4 } },
      // Link referencing an unknown key -> warning, no link written.
      { type: 'link', fromKey: 'a', toKey: 'ghost', kind: 'NOTIFY' },
      { type: 'span.close', key: 'a', endTimeMs: 10 },
    ];
    const pipeline = makePipeline(new OffsetStore(dir));
    const report = await pipeline.ingestAdapter(mockAdapter(events));
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(5);
    expect(report.spansWritten).toBe(1);
    expect(store.getSessionSpans('sess-1')).toHaveLength(1);
  });

  it('mid-file stream failure: keeps completed spans, counts an error, skips the offset', async () => {
    const failing: Adapter = {
      source: 'claude-code',
      detect: async () => ({ source: 'claude-code', homeDir: '/fake', readable: true }),
      discover: async function* () {
        yield makeRef();
      },
      parse: async function* () {
        yield {
          type: 'span.open',
          key: 'a',
          sourceRowKey: 'r1',
          kind: 'SESSION',
          name: 's',
          startTimeMs: 1,
        } satisfies RawEvent;
        yield { type: 'span.close', key: 'a', endTimeMs: 5 } satisfies RawEvent;
        throw new Error('corrupt line 3');
      },
    };
    const offsets = new OffsetStore(dir);
    const pipeline = makePipeline(offsets);
    const report = await pipeline.ingestAdapter(failing);
    expect(report.errors).toBe(1);
    expect(report.filesProcessed).toBe(0);
    // The span completed before the failure is persisted (idempotent ids).
    expect(store.getSessionSpans('sess-1')).toHaveLength(1);
    // No cursor -> the file is retried next run.
    expect(offsets.get('/fake/sess-1.jsonl')).toBeUndefined();
  });

  it("emits a 'span' event for every span written", async () => {
    const pipeline = makePipeline(new OffsetStore(dir));
    const seen: Span[] = [];
    pipeline.events.on('span', (span: Span) => seen.push(span));
    const report = await pipeline.ingestAdapter(mockAdapter(SIMPLE_EVENTS));
    expect(seen).toHaveLength(report.spansWritten);
    expect(seen.map((s) => s.kind)).toEqual(['AGENT_TURN', 'SESSION']); // completion order
  });

  it('closes spans still open at EOF as incomplete', async () => {
    const events: RawEvent[] = [
      { type: 'span.open', key: 'a', sourceRowKey: 'r1', kind: 'SESSION', name: 's', startTimeMs: 100 },
      { type: 'span.open', key: 'b', parentKey: 'a', sourceRowKey: 'r2', kind: 'LLM_CALL', name: 'llm', startTimeMs: 200 },
      { type: 'span.close', key: 'b', endTimeMs: 400 },
    ];
    const pipeline = makePipeline(new OffsetStore(dir));
    await pipeline.ingestAdapter(mockAdapter(events));
    const spans = store.getSessionSpans('sess-1');
    const openOne = spans.find((s) => s.kind === 'SESSION');
    expect(openOne?.attributes[ATTR.INCOMPLETE]).toBe(true);
    expect(openOne?.durationMs).toBe(300); // lastSeen(400) - start(100)
  });

  it('resolves links between previously opened spans', async () => {
    const events: RawEvent[] = [
      { type: 'span.open', key: 'a', sourceRowKey: 'r1', kind: 'AGENT_TURN', name: 'main', startTimeMs: 1 },
      { type: 'span.open', key: 'b', sourceRowKey: 'r2', kind: 'AGENT_TURN', name: 'bg', startTimeMs: 2 },
      { type: 'link', fromKey: 'a', toKey: 'b', kind: 'NOTIFY' },
      { type: 'span.close', key: 'b', endTimeMs: 5 },
      { type: 'span.close', key: 'a', endTimeMs: 6 },
    ];
    const pipeline = makePipeline(new OffsetStore(dir));
    const report = await pipeline.ingestAdapter(mockAdapter(events));
    expect(report.linksWritten).toBe(1);
    const spans = store.getSessionSpans('sess-1');
    const traceId = spans[0]?.traceId ?? '';
    const links = store.getLinks(traceId);
    expect(links).toHaveLength(1);
    expect(links[0]?.kind).toBe('NOTIFY');
  });

  it('redacts summaries by default before persisting', async () => {
    const events: RawEvent[] = [
      {
        type: 'span.open',
        key: 'a',
        sourceRowKey: 'r1',
        kind: 'TOOL_CALL',
        name: 'Bash',
        startTimeMs: 1,
        inputSummary: 'echo sk-ant-aaaabbbbccccdddd',
      },
      { type: 'span.close', key: 'a', endTimeMs: 2, outputSummary: 'token: abcdefgh1234' },
    ];
    const pipeline = makePipeline(new OffsetStore(dir));
    await pipeline.ingestAdapter(mockAdapter(events));
    const [span] = store.getSessionSpans('sess-1');
    expect(span?.inputSummary).toBe('echo [REDACTED]');
    expect(span?.outputSummary).not.toContain('abcdefgh1234');
  });

  it('resumes from the stored offset and advances it', async () => {
    const offsets = new OffsetStore(dir);
    offsets.set('/fake/sess-1.jsonl', { offset: 200, mtime: 900, size: 400 });
    let seenOffset = -1;
    const adapter: Adapter = {
      source: 'claude-code',
      detect: async () => ({ source: 'claude-code', homeDir: '/fake', readable: true }),
      discover: async function* () {
        yield makeRef({ size: 600, mtime: 1100 });
      },
      parse: (_session, fromOffset) => {
        seenOffset = fromOffset;
        return (async function* (): AsyncIterable<RawEvent> {})();
      },
    };
    const pipeline = makePipeline(offsets);
    await pipeline.ingestAdapter(adapter);
    expect(seenOffset).toBe(200);
    expect(offsets.get('/fake/sess-1.jsonl')).toEqual({ offset: 600, mtime: 1100, size: 600 });
  });

  it('re-parses from 0 when the file shrank (truncation/rotation)', async () => {
    const offsets = new OffsetStore(dir);
    offsets.set('/fake/sess-1.jsonl', { offset: 500, mtime: 900, size: 500 });
    let seenOffset = -1;
    const adapter: Adapter = {
      source: 'claude-code',
      detect: async () => ({ source: 'claude-code', homeDir: '/fake', readable: true }),
      discover: async function* () {
        yield makeRef({ size: 120, mtime: 1000 });
      },
      parse: (_session, fromOffset) => {
        seenOffset = fromOffset;
        return (async function* (): AsyncIterable<RawEvent> {})();
      },
    };
    const pipeline = makePipeline(offsets);
    await pipeline.ingestAdapter(adapter);
    expect(seenOffset).toBe(0);
  });

  it('returns an empty report when the adapter detects no home', async () => {
    const noHome: Adapter = {
      source: 'codex',
      detect: async () => null,
      discover: async function* (): AsyncIterable<SessionRef> {},
      parse: async function* (): AsyncIterable<RawEvent> {},
    };
    const pipeline = makePipeline(new OffsetStore(dir));
    const report = await pipeline.ingestAdapter(noHome);
    expect(report).toEqual(emptyIngestReport());
  });

  it('accumulates reports across multiple files', async () => {
    const refs = [makeRef(), makeRef({ sessionId: 'sess-2', filePath: '/fake/sess-2.jsonl' })];
    const pipeline = makePipeline(new OffsetStore(dir));
    const report: IngestReport = await pipeline.ingestAdapter(mockAdapter(SIMPLE_EVENTS, refs));
    expect(report.filesProcessed).toBe(2);
    expect(report.spansWritten).toBe(4);
  });
});
