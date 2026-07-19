import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spanIdFor, traceIdFor } from '../core/ids.js';
import type { Link, Span } from '../core/types.js';
import { TraceStore } from '../store/store.js';
import { buildHtmlDocument, buildNdjsonLines, runExportCommand } from './export.js';

const TRACE_ID = traceIdFor('claude-code', 'sess-1');

function makeSpan(spanId: string, name: string): Span {
  return {
    traceId: TRACE_ID,
    spanId,
    kind: 'TOOL_CALL',
    name,
    startTimeMs: 1000,
    durationMs: 50,
    status: { code: 'ok' },
    attributes: { 'session.id': 'sess-1', source: 'claude-code' },
  };
}

function seed(): { store: TraceStore; spans: Span[]; link: Link } {
  const store = new TraceStore(':memory:');
  const spans = [makeSpan(spanIdFor(TRACE_ID, 'r1'), 'one'), makeSpan(spanIdFor(TRACE_ID, 'r2'), 'two')];
  store.insertSpans(spans);
  const link: Link = { fromSpanId: spans[0]!.spanId, toSpanId: spans[1]!.spanId, kind: 'NOTIFY' };
  store.insertLinks([link]);
  return { store, spans, link };
}

describe('buildNdjsonLines', () => {
  it('round-trips: every line is valid JSON; spans match the store; links are typed', () => {
    const { store, spans, link } = seed();
    try {
      const lines = buildNdjsonLines(store, 'sess-1');
      expect(lines).toBeDefined();
      expect(lines).toHaveLength(3); // 2 spans + 1 link
      const parsed = (lines ?? []).map((line) => JSON.parse(line) as Record<string, unknown>);
      const spanLines = parsed.filter((l) => l['type'] !== 'link');
      const linkLines = parsed.filter((l) => l['type'] === 'link');
      expect(spanLines).toHaveLength(2);
      expect(linkLines).toHaveLength(1);
      // Span lines are exactly what the store returns.
      const fromStore = store.getSessionSpans('sess-1');
      expect(spanLines).toEqual(fromStore.map((s) => JSON.parse(JSON.stringify(s))));
      expect(linkLines[0]).toMatchObject({
        type: 'link',
        fromSpanId: link.fromSpanId,
        toSpanId: link.toSpanId,
        kind: 'NOTIFY',
      });
      void spans;
    } finally {
      store.close();
    }
  });

  it('returns undefined for an unknown session', () => {
    const store = new TraceStore(':memory:');
    try {
      expect(buildNdjsonLines(store, 'nope')).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

const HTML_TRACE_ID = traceIdFor('claude-code', 'sess-html');

function htmlFixtureSpans(): Span[] {
  const root: Span = {
    traceId: HTML_TRACE_ID,
    spanId: spanIdFor(HTML_TRACE_ID, 'root'),
    kind: 'SESSION',
    name: 'session sess-html',
    startTimeMs: 1000,
    durationMs: 500,
    status: { code: 'ok' },
    attributes: { 'session.id': 'sess-html', source: 'claude-code' },
  };
  const child: Span = {
    traceId: HTML_TRACE_ID,
    spanId: spanIdFor(HTML_TRACE_ID, 'child'),
    parentSpanId: root.spanId,
    kind: 'TOOL_CALL',
    name: 'Bash',
    startTimeMs: 1100,
    durationMs: 50,
    status: { code: 'error', message: 'boom' },
    attributes: { 'session.id': 'sess-html', source: 'claude-code', detached: true },
    inputSummary: 'run </script><script>alert(1)</script> now',
    outputSummary: 'done',
    payloadRef: 'payloads/deadbeefcafe1234.json',
    tokenUsage: { inputTokens: 3, outputTokens: 4 },
  };
  return [root, child];
}

interface EmbeddedData {
  version: number;
  session: { sessionId: string; source: string; spanCount: number };
  spans: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
}

function extractEmbeddedData(html: string): { dataBlock: string; data: EmbeddedData } {
  const m = html.match(/<script type="application\/json" id="tya-data">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  const dataBlock = m![1]!;
  return { dataBlock, data: JSON.parse(dataBlock) as EmbeddedData };
}

function seedHtmlStore(): { store: TraceStore; spans: Span[] } {
  const store = new TraceStore(':memory:');
  const spans = htmlFixtureSpans();
  store.insertSpans(spans);
  store.insertLinks([{ fromSpanId: spans[0]!.spanId, toSpanId: spans[1]!.spanId, kind: 'NOTIFY' }]);
  return { store, spans };
}

describe('buildHtmlDocument', () => {
  it('embeds the session header, spans and links as parseable JSON', () => {
    const { store, spans } = seedHtmlStore();
    try {
      const html = buildHtmlDocument(store, 'sess-html', 1_700_000_000_000);
      expect(html).toBeDefined();
      expect(html).toContain('sess-html');
      const { data } = extractEmbeddedData(html!);
      expect(data.version).toBe(1);
      expect(data.session.sessionId).toBe('sess-html');
      expect(data.session.source).toBe('claude-code');
      expect(data.session.spanCount).toBe(2);
      expect(data.spans).toHaveLength(2);
      expect(data.spans.map((s) => s['spanId'])).toEqual(spans.map((s) => s.spanId));
      expect(data.spans[1]?.['parentSpanId']).toBe(spans[0]!.spanId);
      expect(data.links).toEqual([
        { fromSpanId: spans[0]!.spanId, toSpanId: spans[1]!.spanId, kind: 'NOTIFY' },
      ]);
    } finally {
      store.close();
    }
  });

  it('neutralizes </script> injection inside span content', () => {
    const { store } = seedHtmlStore();
    try {
      const html = buildHtmlDocument(store, 'sess-html')!;
      // Exactly the two real script blocks (data + renderer); nothing injected.
      expect(html.match(/<\/script>/g)).toHaveLength(2);
      const { dataBlock, data } = extractEmbeddedData(html);
      expect(dataBlock).not.toContain('</');
      // The hostile string survives as data, not markup.
      expect(data.spans[1]?.['inputSummary']).toBe('run </script><script>alert(1)</script> now');
    } finally {
      store.close();
    }
  });

  it('strips payloadRef: no payload bodies or refs in the export (privacy)', () => {
    const { store } = seedHtmlStore();
    try {
      const html = buildHtmlDocument(store, 'sess-html')!;
      expect(html).not.toContain('payloadRef');
      expect(html).not.toContain('deadbeefcafe1234');
      // Summaries stay — they are the redacted, shareable part.
      expect(html).toContain('done');
    } finally {
      store.close();
    }
  });

  it('returns undefined for an unknown session', () => {
    const store = new TraceStore(':memory:');
    try {
      expect(buildHtmlDocument(store, 'nope')).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe('runExportCommand --format html', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tya-export-html-'));
    prevHome = process.env['TYA_HOME'];
    process.env['TYA_HOME'] = dir;
    const store = new TraceStore(join(dir, 'trace.db'));
    store.insertSpans(htmlFixtureSpans());
    store.close();
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env['TYA_HOME'];
    } else {
      process.env['TYA_HOME'] = prevHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a self-contained html file to --out', async () => {
    const outPath = join(dir, 'x.html');
    const code = await runExportCommand(['sess-html', '--format', 'html', '--out', outPath]);
    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const html = readFileSync(outPath, 'utf8');
    expect(html).toContain('sess-html');
    const { data } = extractEmbeddedData(html);
    expect(data.spans).toHaveLength(2);
    expect(html).not.toContain('payloadRef');
  });

  it('defaults to ./<sessionId>.html when --out is omitted', async () => {
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const code = await runExportCommand(['sess-html', '--format', 'html']);
      expect(code).toBe(0);
      expect(existsSync(join(dir, 'sess-html.html'))).toBe(true);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('fails for an unknown session', async () => {
    expect(await runExportCommand(['nope', '--format', 'html', '--out', join(dir, 'y.html')])).toBe(
      1,
    );
    expect(existsSync(join(dir, 'y.html'))).toBe(false);
  });
});
