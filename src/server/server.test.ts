import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IngestPipeline } from '../core/ingest.js';
import { OffsetStore } from '../core/offsets.js';
import { PayloadStore } from '../core/payload-store.js';
import type { Adapter, RawEvent, SessionRef } from '../core/source.js';
import type { Source } from '../core/types.js';
import { TraceStore } from '../store/store.js';
import { startServer, type RunningServer } from './server.js';

/**
 * End-to-end tests for the HTTP API: real ingest pipeline (mock adapters)
 * feeding a real store in a temp TYA_HOME, real server on an ephemeral port,
 * real HTTP via node fetch.
 */

let homeDir: string;
let store: TraceStore;
let payloads: PayloadStore;
let server: RunningServer;
let base: string;
let payloadRef = '';

function makeRef(source: Source, sessionId: string): SessionRef {
  return { source, sessionId, filePath: `/fake/${sessionId}.jsonl`, mtime: 1000, size: 500 };
}

function mockAdapter(
  source: Source,
  events: readonly RawEvent[],
  refs: readonly SessionRef[],
): Adapter {
  return {
    source,
    detect: async () => ({ source, homeDir: '/fake', readable: true }),
    discover: async function* () {
      for (const ref of refs) yield ref;
    },
    parse: async function* () {
      for (const event of events) yield event;
    },
  };
}

async function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`);
}

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'tya-server-'));
  store = new TraceStore(join(homeDir, 'trace.db'));
  payloads = new PayloadStore(homeDir);
  const pipeline = new IngestPipeline({ store, offsets: new OffsetStore(homeDir), payloads });

  payloadRef = payloads.put({ command: 'echo hello-world' });
  const sess1Events: RawEvent[] = [
    { type: 'session.meta', cwd: '/repo', startedAtMs: 1000 },
    { type: 'span.open', key: 's', sourceRowKey: 'r1', kind: 'SESSION', name: 'session', startTimeMs: 1000 },
    { type: 'span.open', key: 't1', parentKey: 's', sourceRowKey: 'r2', kind: 'AGENT_TURN', name: 'turn 1', startTimeMs: 1100 },
    {
      type: 'span.open',
      key: 'tc',
      parentKey: 't1',
      sourceRowKey: 'r3',
      kind: 'TOOL_CALL',
      name: 'Bash',
      startTimeMs: 1200,
      toolName: 'Bash',
      inputSummary: 'echo hello-world',
      payloadRef,
    },
    { type: 'span.open', key: 't2', parentKey: 's', sourceRowKey: 'r4', kind: 'AGENT_TURN', name: 'turn 2', startTimeMs: 1300 },
    { type: 'link', fromKey: 't1', toKey: 't2', kind: 'NOTIFY' },
    { type: 'span.close', key: 'tc', endTimeMs: 1400, outputSummary: 'hello-world output' },
    { type: 'span.close', key: 't1', endTimeMs: 1500, tokenUsage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'span.close', key: 't2', endTimeMs: 1550 },
    { type: 'span.close', key: 's', endTimeMs: 1600 },
  ];
  const sess2Events: RawEvent[] = [
    { type: 'session.meta', cwd: '/other', startedAtMs: 2000 },
    { type: 'span.open', key: 's', sourceRowKey: 'r1', kind: 'SESSION', name: 'session', startTimeMs: 2000 },
    { type: 'span.close', key: 's', endTimeMs: 2100 },
  ];
  await pipeline.ingestAdapter(mockAdapter('claude-code', sess1Events, [makeRef('claude-code', 'sess-1')]));
  await pipeline.ingestAdapter(mockAdapter('kimi-code', sess2Events, [makeRef('kimi-code', 'sess-2')]));

  server = await startServer({ store, payloads, port: 0, uiDir: join(homeDir, 'ui-not-built') });
  base = server.url;
});

afterEach(async () => {
  await server.close();
  store.close();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('tya http api', () => {
  it('GET /api/health returns { ok: true }', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /api/sessions lists summaries with the contract fields and total', async () => {
    const res = await get('/api/sessions');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sessions).toHaveLength(2);
    // Default order: started_at DESC — sess-2 (2000) before sess-1 (1000).
    const [first, second] = body.sessions;
    expect(first.sessionId).toBe('sess-2');
    expect(second.sessionId).toBe('sess-1');
    expect(second).toMatchObject({
      source: 'claude-code',
      cwd: '/repo',
      startedAtMs: 1000,
      spanCount: 4,
      turnCount: 2,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      errorCount: 0,
    });
    expect(second.joinQualityStats).toBeTypeOf('object');
  });

  it('GET /api/sessions filters by source, q, and paginates', async () => {
    const bySource = await (await get('/api/sessions?source=kimi-code')).json();
    expect(bySource.total).toBe(1);
    expect(bySource.sessions[0].sessionId).toBe('sess-2');

    // q is a substring filter over sessionId/cwd.
    const byCwd = await (await get('/api/sessions?q=repo')).json();
    expect(byCwd.total).toBe(1);
    expect(byCwd.sessions[0].sessionId).toBe('sess-1');
    const byId = await (await get('/api/sessions?q=sess')).json();
    expect(byId.total).toBe(2);

    const page1 = await (await get('/api/sessions?limit=1&offset=0')).json();
    expect(page1.sessions).toHaveLength(1);
    expect(page1.total).toBe(2);
    const page2 = await (await get('/api/sessions?limit=1&offset=1')).json();
    expect(page2.sessions).toHaveLength(1);
    expect(page2.sessions[0].sessionId).not.toBe(page1.sessions[0].sessionId);
  });

  it('GET /api/sessions rejects bad params with { error } + 400', async () => {
    for (const path of ['/api/sessions?source=bogus', '/api/sessions?limit=0', '/api/sessions?limit=x', '/api/sessions?offset=-1']) {
      const res = await get(path);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTypeOf('string');
    }
  });

  it('GET /api/sessions/:sessionId returns one summary, 404 when missing', async () => {
    const res = await get('/api/sessions/sess-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ sessionId: 'sess-1', source: 'claude-code', spanCount: 4 });

    const missing = await get('/api/sessions/nope');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBeTypeOf('string');
  });

  it('GET /api/sessions/:sessionId/spans returns spans (with parentSpanId) and links', async () => {
    const res = await get('/api/sessions/sess-1/spans');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spans).toHaveLength(4);
    expect(body.links).toHaveLength(1);
    expect(body.links[0]).toMatchObject({ kind: 'NOTIFY' });

    const root = body.spans.find((s: { kind: string }) => s.kind === 'SESSION');
    expect(root.parentSpanId).toBeUndefined();
    const turn1 = body.spans.find((s: { name: string }) => s.name === 'turn 1');
    expect(turn1.parentSpanId).toBe(root.spanId);
    const tool = body.spans.find((s: { kind: string }) => s.kind === 'TOOL_CALL');
    expect(tool.parentSpanId).toBe(turn1.spanId);
    expect(tool.toolName).toBe('Bash');
    expect(tool.payloadRef).toBe(payloadRef);

    const missing = await get('/api/sessions/nope/spans');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBeTypeOf('string');
  });

  it('GET /api/search finds spans via FTS and shapes SearchHit', async () => {
    const res = await get('/api/search?q=hello-world');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBeGreaterThan(0);
    const hit = body.results.find((h: { kind: string }) => h.kind === 'TOOL_CALL');
    expect(hit).toBeDefined();
    expect(hit.sessionId).toBe('sess-1');
    expect(hit.name).toBe('Bash');
    expect(hit.toolName).toBe('Bash');
    expect(hit.snippet).toContain('hello-world');
    expect(hit.startTimeMs).toBe(1200);
    expect(hit.spanId).toBeTypeOf('string');

    // Filtered to the other source: no hits.
    const filtered = await (await get('/api/search?q=hello-world&source=kimi-code')).json();
    expect(filtered.results).toHaveLength(0);
  });

  it('GET /api/search without q is a 400 with { error }', async () => {
    const res = await get('/api/search');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTypeOf('string');
  });

  it('GET /api/payloads/:ref serves stored payloads, 404 otherwise', async () => {
    const ref = payloadRef.slice('payloads/'.length);
    const res = await get(`/api/payloads/${ref}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ command: 'echo hello-world' });

    const unknown = await get(`/api/payloads/${'0'.repeat(64)}.json`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBeTypeOf('string');

    const garbage = await get('/api/payloads/garbage');
    expect(garbage.status).toBe(404);
  });

  it('unknown non-API GETs fall back to the UI (or the not-built hint page)', async () => {
    for (const path of ['/', '/sessions', '/some/spa/route']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('UI not built, run npm run build:ui');
    }
  });

  it('unknown /api paths return a JSON 404', async () => {
    const res = await get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).error).toBeTypeOf('string');
  });
});

describe('startServer port handling', () => {
  it('falls back to the next port when the requested one is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolveListen) => blocker.listen(0, '127.0.0.1', resolveListen));
    const address = blocker.address();
    const takenPort = typeof address === 'object' && address !== null ? address.port : 0;
    expect(takenPort).toBeGreaterThan(0);

    const tempHome = mkdtempSync(join(tmpdir(), 'tya-server-port-'));
    const tempStore = new TraceStore(join(tempHome, 'trace.db'));
    try {
      const fallback = await startServer({
        store: tempStore,
        payloads: new PayloadStore(tempHome),
        port: takenPort,
        maxAttempts: 3,
        uiDir: join(tempHome, 'no-ui'),
      });
      expect(fallback.port).toBe(takenPort + 1);
      const res = await fetch(`${fallback.url}/api/health`);
      expect(await res.json()).toEqual({ ok: true });
      await fallback.close();
    } finally {
      tempStore.close();
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
