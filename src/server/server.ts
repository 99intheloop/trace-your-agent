import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { PayloadStore } from '../core/payload-store.js';
import { ATTR, type Link, type Source, type Span } from '../core/types.js';
import type { ListSessionsFilter, SessionRow, TraceStore } from '../store/store.js';

/**
 * Local HTTP API + static host for the web UI. Implements docs/api.md.
 *
 * Deliberate choices:
 * - **No CORS headers.** The UI is served same-origin by this server; during
 *   UI development Vite proxies /api, so no cross-origin browser client exists.
 * - **One-shot JSON for `/spans`.** better-sqlite3 reads synchronously and a
 *   50k-span session serializes to a few tens of MB — fine for a localhost
 *   tool. Streaming NDJSON would complicate the client for no local win.
 * - **Errors** always `{ error: string }` with a fitting status code.
 */

/** SessionSummary per docs/api.md: `cwd`/`startedAtMs` are omitted when unknown. */
interface SessionSummary {
  sessionId: string;
  source: string;
  cwd?: string;
  startedAtMs?: number;
  spanCount: number;
  agentCount: number;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  errorCount: number;
  joinQualityStats: Record<string, number>;
}

/** SearchHit per docs/api.md. */
interface SearchHit {
  spanId: string;
  sessionId: string;
  kind: Span['kind'];
  name: string;
  toolName?: string;
  snippet: string;
  startTimeMs: number;
}

export interface ServerDeps {
  store: TraceStore;
  payloads: PayloadStore;
  /** Built UI directory (dist/ui). When it lacks index.html a hint page is served instead. */
  uiDir?: string;
}

export interface StartServerOptions extends ServerDeps {
  /** Requested port (default 4777). Pass 0 for an OS-assigned ephemeral port (tests). */
  port?: number;
  /** Bind host (default 127.0.0.1 — localhost only, this is a local-first tool). */
  host?: string;
  /** Port attempts before giving up: port, port+1, ... (default 10). */
  maxAttempts?: number;
}

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export const DEFAULT_PORT = 4777;
const DEFAULT_MAX_ATTEMPTS = 10;
const VALID_SOURCES: readonly Source[] = ['claude-code', 'codex', 'kimi-code'];
const SNIPPET_MAX_CHARS = 200;

const UI_NOT_BUILT_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>tya</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem;">
  <h1>tya</h1>
  <p>UI not built, run npm run build:ui</p>
</body>
</html>
`;

/** Default UI directory: dist/ui next to the bundled dist/cli.js, or <root>/dist/ui from src. */
export function defaultUiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const besideBundle = join(here, 'ui'); // bundled: dist/cli.js sits beside dist/ui
  if (existsSync(besideBundle)) return besideBundle;
  return resolve(here, '../../dist/ui'); // running from src/server (dev/tests)
}

function toSessionSummary(row: SessionRow): SessionSummary {
  return {
    sessionId: row.sessionId,
    source: row.source,
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
    ...(row.startedAtMs !== null ? { startedAtMs: row.startedAtMs } : {}),
    spanCount: row.spanCount,
    agentCount: row.agentCount,
    turnCount: row.turnCount,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    totalCostUsd: row.totalCostUsd,
    errorCount: row.errorCount,
    joinQualityStats: row.joinQualityStats,
  };
}

/** Parse an integer query param. Returns the number, or an error message string. */
function parseIntParam(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
): number | string {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    return `${name} must be an integer >= ${min}`;
  }
  return value;
}

/** Parse the optional `source` query param. */
function parseSourceParam(raw: string | undefined): { source?: Source; error?: string } {
  if (raw === undefined || raw === '') return {};
  if ((VALID_SOURCES as readonly string[]).includes(raw)) return { source: raw as Source };
  return { error: `source must be one of ${VALID_SOURCES.join('|')}` };
}

/** Build a snippet from the first field the query matches in (name/inputSummary/outputSummary). */
function makeSnippet(span: Span, query: string): string {
  const token = query.match(/[\p{L}\p{N}_.-]+/u)?.[0];
  const fields = [span.inputSummary, span.outputSummary, span.name].filter(
    (f): f is string => typeof f === 'string' && f !== '',
  );
  if (token !== undefined) {
    const needle = token.toLowerCase();
    for (const field of fields) {
      const at = field.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      const start = Math.max(0, at - 60);
      const prefix = start > 0 ? '…' : '';
      const body = field.slice(start, start + SNIPPET_MAX_CHARS);
      const suffix = start + SNIPPET_MAX_CHARS < field.length ? '…' : '';
      return `${prefix}${body}${suffix}`;
    }
  }
  const fallback = fields[0] ?? '';
  return fallback.length <= SNIPPET_MAX_CHARS ? fallback : `${fallback.slice(0, SNIPPET_MAX_CHARS)}…`;
}

function toSearchHit(span: Span, query: string): SearchHit {
  const sessionId = span.attributes[ATTR.SESSION_ID];
  return {
    spanId: span.spanId,
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    kind: span.kind,
    name: span.name,
    ...(span.toolName !== undefined ? { toolName: span.toolName } : {}),
    snippet: makeSnippet(span, query),
    startTimeMs: span.startTimeMs,
  };
}

/** Build the hono app (pure — no listening socket; see {@link startServer}). */
export function createApp(deps: ServerDeps): Hono {
  const { store, payloads } = deps;
  const uiDir = deps.uiDir ?? defaultUiDir();
  const indexPath = join(uiDir, 'index.html');
  const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : undefined;

  const app = new Hono();

  app.onError((error, c) => {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/sessions', (c) => {
    const sourceRes = parseSourceParam(c.req.query('source'));
    if (sourceRes.error !== undefined) return c.json({ error: sourceRes.error }, 400);
    const limit = parseIntParam(c.req.query('limit'), 'limit', 50, 1);
    if (typeof limit === 'string') return c.json({ error: limit }, 400);
    const offset = parseIntParam(c.req.query('offset'), 'offset', 0, 0);
    if (typeof offset === 'string') return c.json({ error: offset }, 400);

    const q = c.req.query('q');
    const filter: ListSessionsFilter = {
      ...(sourceRes.source !== undefined ? { source: sourceRes.source } : {}),
      ...(q !== undefined && q !== '' ? { q } : {}),
      limit,
      offset,
    };
    const sessions = store.listSessions(filter).map(toSessionSummary);
    const total = store.countSessions(filter);
    return c.json({ sessions, total });
  });

  /** Per-source session counts (drives the UI filter tabs). */
  app.get('/api/sources', (c) => {
    const sources = VALID_SOURCES.map((source) => ({
      source,
      count: store.countSessions({ source }),
    }));
    return c.json({ sources, total: store.countSessions() });
  });

  app.get('/api/sessions/:sessionId', (c) => {
    const row = store.getSessionRow(c.req.param('sessionId'));
    if (row === undefined) return c.json({ error: 'session not found' }, 404);
    return c.json(toSessionSummary(row));
  });

  app.get('/api/sessions/:sessionId/spans', (c) => {
    const spans = store.getSessionSpans(c.req.param('sessionId'));
    if (spans.length === 0) return c.json({ error: 'session not found' }, 404);
    // A session may span multiple traces (sidechain files share session.id);
    // getLinks is per-trace, so union over the session's trace ids.
    const seen = new Set<string>();
    const links: Link[] = [];
    for (const traceId of new Set(spans.map((s) => s.traceId))) {
      for (const link of store.getLinks(traceId)) {
        const key = `${link.fromSpanId}${link.toSpanId}${link.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push(link);
      }
    }
    return c.json({ spans, links });
  });

  app.get('/api/search', (c) => {
    const q = c.req.query('q');
    if (q === undefined || q.trim() === '') return c.json({ error: 'q is required' }, 400);
    const sourceRes = parseSourceParam(c.req.query('source'));
    if (sourceRes.error !== undefined) return c.json({ error: sourceRes.error }, 400);
    const limit = parseIntParam(c.req.query('limit'), 'limit', 100, 1);
    if (typeof limit === 'string') return c.json({ error: limit }, 400);

    const spans = store.searchSpans(q, {
      ...(sourceRes.source !== undefined ? { source: sourceRes.source } : {}),
      limit,
    });
    return c.json({ results: spans.map((span) => toSearchHit(span, q)) });
  });

  app.get('/api/payloads/:ref', (c) => {
    const ref = c.req.param('ref');
    if (!/^[0-9a-f]{64}\.json$/.test(ref)) return c.json({ error: 'payload not found' }, 404);
    try {
      return c.json(payloads.get(`payloads/${ref}`));
    } catch {
      return c.json({ error: 'payload not found' }, 404);
    }
  });

  // Static hosting (dist/ui) — only when the UI has actually been built.
  // Registered after the API routes so /api/* handlers win by registration order.
  if (indexHtml !== undefined) {
    app.use(serveStatic({ root: uiDir }));
  }

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'not found' }, 404);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.json({ error: 'not found' }, 404);
    }
    // SPA history-route fallback: unknown non-API GETs serve the app shell,
    // or a hint page when the UI has not been built yet.
    return c.html(indexHtml ?? UI_NOT_BUILT_PAGE);
  });

  return app;
}

/**
 * Start listening. If the requested port is taken, the next one is tried,
 * up to `maxAttempts` total attempts. A fresh node Server is created per
 * attempt (re-listening on a server that hit EADDRINUSE is not reliable).
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? DEFAULT_PORT;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const app = createApp(options);

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = requestedPort === 0 ? 0 : requestedPort + attempt;
    const server = createAdaptorServer({ fetch: app.fetch }) as Server;
    try {
      const port = await listen(server, candidate, host);
      return {
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.closeAllConnections();
            server.close((err) => (err === undefined ? resolveClose() : rejectClose(err)));
          }),
      };
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(
    `no free port in range ${requestedPort}..${requestedPort + maxAttempts - 1}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const address = server.address();
      resolveListen(typeof address === 'object' && address !== null ? address.port : port);
    });
  });
}
