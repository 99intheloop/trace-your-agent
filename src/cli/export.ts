import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ATTR, type Link, type Span } from '../core/types.js';
import type { TraceStore } from '../store/store.js';
import { err, openStore, out } from './util.js';

const HELP = `tya export — Export a session/trace

Usage: tya export <sessionId> [options]

Options:
  --format <ndjson|html>  Output format (default: ndjson)
  --out <file>            Write to a file (ndjson defaults to stdout;
                          html defaults to ./<sessionId>.html)
  -h, --help              Show this help

NDJSON layout: one JSON span per line (exactly as stored), then one
{"type":"link",...} line per cross-span link.

HTML output is a single self-contained file (embedded spans+links JSON plus a
dependency-free tree renderer) that you can send to a teammate — no service
needed. It contains only summaries and attributes; payload bodies and payload
refs never leave the local store.
`;

/**
 * Build the NDJSON export for a session: one JSON-encoded span per line
 * (the Span object exactly as read from the store), followed by one
 * `{"type":"link", ...}` line per link. Returns `undefined` when the
 * session has no spans.
 */
export function buildNdjsonLines(store: TraceStore, sessionId: string): string[] | undefined {
  const spans = store.getSessionSpans(sessionId);
  if (spans.length === 0) return undefined;
  const lines = spans.map((span) => JSON.stringify(span));
  const traceId = spans[0]?.traceId;
  if (traceId !== undefined) {
    for (const link of store.getLinks(traceId)) {
      lines.push(JSON.stringify({ type: 'link', ...link }));
    }
  }
  return lines;
}

/** Session header embedded in the HTML export. */
interface HtmlExportSession {
  sessionId: string;
  source: string;
  startedAtMs: number | null;
  spanCount: number;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  errorCount: number;
}

interface HtmlExportData {
  version: 1;
  generatedAtMs: number;
  session: HtmlExportSession;
  spans: Array<Omit<Span, 'payloadRef'>>;
  links: Link[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build a self-contained HTML export for a session. Returns `undefined` when
 * the session has no spans.
 *
 * Privacy decision: this file is meant to be shared as-is (mail it to a
 * teammate, open it in any browser — no service required), so it NEVER embeds
 * payload bodies. Only the <=500-char input/output summaries (already
 * secret-redacted at ingest when redact is on) and the span attributes are
 * included; even `payloadRef` hashes are stripped, since they are useless
 * without the local payload store and would only leak the store's layout.
 * Sharing a trace therefore stays verifiable: what you see in the HTML is all
 * the recipient gets.
 */
export function buildHtmlDocument(
  store: TraceStore,
  sessionId: string,
  nowMs: number = Date.now(),
): string | undefined {
  const rawSpans = store.getSessionSpans(sessionId);
  if (rawSpans.length === 0) return undefined;
  const traceId = rawSpans[0]?.traceId;
  const links = traceId !== undefined ? store.getLinks(traceId) : [];

  let sessionRow = store.getSessionRow(sessionId);
  if (sessionRow === undefined) {
    // The argument may be a traceId rather than a session.id.
    const sid = rawSpans[0]?.attributes[ATTR.SESSION_ID];
    if (typeof sid === 'string') sessionRow = store.getSessionRow(sid);
  }
  const session: HtmlExportSession =
    sessionRow !== undefined
      ? {
          sessionId: sessionRow.sessionId,
          source: sessionRow.source,
          startedAtMs: sessionRow.startedAtMs,
          spanCount: sessionRow.spanCount,
          turnCount: sessionRow.turnCount,
          totalInputTokens: sessionRow.totalInputTokens,
          totalOutputTokens: sessionRow.totalOutputTokens,
          totalCostUsd: sessionRow.totalCostUsd,
          errorCount: sessionRow.errorCount,
        }
      : {
          sessionId,
          source: 'unknown',
          startedAtMs: rawSpans[0]?.startTimeMs ?? null,
          spanCount: rawSpans.length,
          turnCount: rawSpans.filter((s) => s.kind === 'AGENT_TURN').length,
          totalInputTokens: rawSpans.reduce((n, s) => n + (s.tokenUsage?.inputTokens ?? 0), 0),
          totalOutputTokens: rawSpans.reduce((n, s) => n + (s.tokenUsage?.outputTokens ?? 0), 0),
          totalCostUsd: 0,
          errorCount: rawSpans.filter((s) => s.status.code === 'error').length,
        };

  const spans = rawSpans.map((span) => {
    const { payloadRef: _dropped, ...rest } = span;
    return rest;
  });

  const data: HtmlExportData = { version: 1, generatedAtMs: nowMs, session, spans, links };
  // Escape every `<` so an embedded `</script>` (or `<!--`) inside trace
  // content can never break out of the data block; `<` is valid JSON.
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tya trace — ${escapeHtml(session.sessionId)}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { background: #0d1117; color: #c9d1d9; margin: 0; padding: 24px;
  font: 13px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
h1 { font-size: 16px; margin: 0 0 4px; color: #f0f6fc; font-weight: 600; }
.meta { color: #8b949e; margin-bottom: 4px; }
.privacy { color: #6e7681; font-size: 12px; margin-bottom: 18px; }
#tree, #links { max-width: 1400px; }
.children { margin-left: 16px; border-left: 1px solid #21262d; padding-left: 10px; }
.row { display: flex; align-items: center; gap: 8px; padding: 2px 6px;
  border-radius: 6px; cursor: pointer; white-space: nowrap; }
.row:hover { background: #161b22; }
.badge { color: #0d1117; font-size: 10px; font-weight: 700; padding: 1px 6px;
  border-radius: 8px; flex: none; }
.name { color: #f0f6fc; overflow: hidden; text-overflow: ellipsis; }
.dur { color: #8b949e; flex: none; }
.tok { color: #d2a8ff; flex: none; }
.marker { color: #e3b341; flex: none; }
.marker.err { color: #f85149; }
.detail { display: none; margin: 4px 0 8px 26px; padding: 10px 12px;
  background: #161b22; border: 1px solid #21262d; border-radius: 8px; }
.detail.open { display: block; }
table.kv { border-collapse: collapse; max-width: 100%; }
table.kv td { padding: 1px 12px 1px 0; vertical-align: top; }
td.k { color: #8b949e; white-space: nowrap; }
td.v { color: #c9d1d9; word-break: break-all; }
.sumlabel { color: #8b949e; margin-top: 8px; font-size: 11px; text-transform: uppercase; }
pre.sum { background: #0d1117; border: 1px solid #21262d; border-radius: 6px;
  padding: 8px; margin: 2px 0; overflow: auto; white-space: pre-wrap;
  word-break: break-word; color: #a5d6ff; }
ul.events { margin: 2px 0; padding-left: 18px; }
.unattached { color: #e3b341; margin: 14px 0 6px; }
h2 { font-size: 13px; color: #8b949e; font-weight: 600; }
#links ul { margin: 4px 0; padding-left: 18px; color: #8b949e; }
</style>
</head>
<body>
<h1 id="title"></h1>
<div id="meta" class="meta"></div>
<div class="privacy">Self-contained trace export by trace-your-agent. Payload bodies are
not included by design — only redacted summaries and span attributes.</div>
<div id="tree"></div>
<div id="links"></div>
<script type="application/json" id="tya-data">${dataJson}</script>
<script>
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('tya-data').textContent);
  var spans = data.spans;
  var links = data.links;
  var meta = data.session;

  var KIND_COLORS = {
    SESSION: '#6e7681',
    AGENT_TURN: '#58a6ff',
    LLM_CALL: '#bc8cff',
    TOOL_CALL: '#3fb950'
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function fmtDur(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    var m = Math.floor(ms / 60000);
    var s = Math.round((ms % 60000) / 1000);
    return m + 'm' + s + 's';
  }
  function fmtTime(ms) {
    if (ms === null || ms === undefined) return '-';
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  }
  function marker(ch, title, cls) {
    var e = el('span', 'marker' + (cls ? ' ' + cls : ''), ch);
    e.title = title;
    return e;
  }

  document.getElementById('title').textContent = 'tya trace — ' + meta.sessionId;
  document.getElementById('meta').textContent =
    meta.source + '  ·  started ' + fmtTime(meta.startedAtMs) +
    '  ·  ' + meta.spanCount + ' spans' +
    '  ·  ' + meta.turnCount + ' turns' +
    '  ·  ' + meta.totalInputTokens + '+' + meta.totalOutputTokens + ' tokens' +
    '  ·  $' + Number(meta.totalCostUsd).toFixed(4) +
    '  ·  ' + meta.errorCount + ' error(s)' +
    '  ·  exported ' + fmtTime(data.generatedAtMs);

  var byId = new Map();
  spans.forEach(function (s) { byId.set(s.spanId, { span: s, children: [] }); });
  var roots = [];
  var orphans = [];
  byId.forEach(function (node) {
    var pid = node.span.parentSpanId;
    if (pid === undefined || pid === null) { roots.push(node); return; }
    var parent = byId.get(pid);
    if (parent === undefined) { orphans.push(node); return; }
    parent.children.push(node);
  });
  function byStart(a, b) {
    return (a.span.startTimeMs - b.span.startTimeMs) ||
      (a.span.spanId < b.span.spanId ? -1 : 1);
  }
  byId.forEach(function (node) { node.children.sort(byStart); });
  roots.sort(byStart);
  orphans.sort(byStart);

  function kv(table, k, v) {
    var tr = el('tr');
    tr.appendChild(el('td', 'k', k));
    tr.appendChild(el('td', 'v', v));
    table.appendChild(tr);
  }

  function detailFor(span) {
    var d = el('div', 'detail');
    var table = el('table', 'kv');
    kv(table, 'spanId', span.spanId);
    kv(table, 'kind', span.kind);
    kv(table, 'start', fmtTime(span.startTimeMs));
    kv(table, 'duration', fmtDur(span.durationMs) + ' (' + span.durationMs + ' ms)');
    kv(table, 'status', span.status.code +
      (span.status.message ? ' — ' + span.status.message : ''));
    if (span.agentName) kv(table, 'agent', span.agentName);
    if (span.toolName) kv(table, 'tool', span.toolName);
    if (span.tokenUsage) {
      var t = span.tokenUsage;
      var tok = t.inputTokens + ' in / ' + t.outputTokens + ' out';
      if (t.cacheReadTokens) tok += ' / ' + t.cacheReadTokens + ' cache-read';
      if (t.cacheWriteTokens) tok += ' / ' + t.cacheWriteTokens + ' cache-write';
      kv(table, 'tokens', tok);
    }
    var attrs = span.attributes || {};
    Object.keys(attrs).sort().forEach(function (k) { kv(table, k, attrs[k]); });
    d.appendChild(table);
    if (span.inputSummary) {
      d.appendChild(el('div', 'sumlabel', 'input'));
      d.appendChild(el('pre', 'sum', span.inputSummary));
    }
    if (span.outputSummary) {
      d.appendChild(el('div', 'sumlabel', 'output'));
      d.appendChild(el('pre', 'sum', span.outputSummary));
    }
    if (span.events && span.events.length) {
      d.appendChild(el('div', 'sumlabel', 'events'));
      var ul = el('ul', 'events');
      span.events.forEach(function (ev) {
        ul.appendChild(el('li', null, fmtTime(ev.timestampMs) + '  ' + ev.name));
      });
      d.appendChild(ul);
    }
    return d;
  }

  function renderNode(node) {
    var span = node.span;
    var wrap = el('div', 'node');
    var row = el('div', 'row');
    var badge = el('span', 'badge', span.kind);
    badge.style.backgroundColor = KIND_COLORS[span.kind] || '#6e7681';
    row.appendChild(badge);
    row.appendChild(el('span', 'name', span.name));
    row.appendChild(el('span', 'dur', fmtDur(span.durationMs)));
    if (span.tokenUsage) {
      row.appendChild(el('span', 'tok',
        span.tokenUsage.inputTokens + ' in / ' + span.tokenUsage.outputTokens + ' out'));
    }
    var attrs = span.attributes || {};
    if (attrs['detached'] === true) row.appendChild(marker('⏚', 'detached background subtree'));
    if (attrs['incomplete'] === true) row.appendChild(marker('⚠', 'incomplete (closed at end of file)'));
    if (attrs['approx'] === true) row.appendChild(marker('≈', 'duration is approximated'));
    if (span.status && span.status.code === 'error') {
      row.appendChild(marker('✗', span.status.message || 'error', 'err'));
    }
    wrap.appendChild(row);
    var childrenWrap = el('div', 'children');
    node.children.forEach(function (child) { childrenWrap.appendChild(renderNode(child)); });
    wrap.appendChild(childrenWrap);
    var detail = null;
    row.addEventListener('click', function () {
      if (detail === null) {
        detail = detailFor(span);
        wrap.insertBefore(detail, childrenWrap);
      }
      detail.classList.toggle('open');
    });
    return wrap;
  }

  var tree = document.getElementById('tree');
  roots.forEach(function (node) { tree.appendChild(renderNode(node)); });
  if (orphans.length) {
    tree.appendChild(el('div', 'unattached', '(unattached)'));
    orphans.forEach(function (node) { tree.appendChild(renderNode(node)); });
  }

  if (links.length) {
    var linksEl = document.getElementById('links');
    linksEl.appendChild(el('h2', null, 'links (' + links.length + ')'));
    var ul = el('ul');
    links.forEach(function (l) {
      ul.appendChild(el('li', null, l.fromSpanId + ' → ' + l.toSpanId + '  (' + l.kind + ')'));
    });
    linksEl.appendChild(ul);
  }
})();
</script>
</body>
</html>
`;
}

export async function runExportCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      format: { type: 'string', default: 'ndjson' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  if (values.help === true) {
    out(HELP);
    return 0;
  }
  const format = values.format;
  if (format !== 'ndjson' && format !== 'html') {
    err(`tya export: unknown format '${format}' (expected ndjson|html)`);
    return 1;
  }
  const sessionId = positionals[0];
  if (sessionId === undefined) {
    err('tya export: missing <sessionId>. See `tya export --help`.');
    return 1;
  }

  const { store, close } = openStore();
  try {
    if (format === 'html') {
      const html = buildHtmlDocument(store, sessionId);
      if (html === undefined) {
        err(`tya export: session not found: ${sessionId}`);
        return 1;
      }
      const outPath =
        typeof values.out === 'string' ? values.out : `${sessionId.replace(/[\\/]/g, '_')}.html`;
      writeFileSync(outPath, html, 'utf8');
      out(`exported self-contained html to ${outPath}`);
      return 0;
    }
    const lines = buildNdjsonLines(store, sessionId);
    if (lines === undefined) {
      err(`tya export: session not found: ${sessionId}`);
      return 1;
    }
    const body = `${lines.join('\n')}\n`;
    if (typeof values.out === 'string') {
      writeFileSync(values.out, body, 'utf8');
      out(`exported ${lines.length} line(s) to ${values.out}`);
    } else {
      process.stdout.write(body);
    }
    return 0;
  } finally {
    close();
  }
}
