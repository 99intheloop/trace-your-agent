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
  /** spanQ 过滤时:该 session 的 FTS 命中 span 数。 */
  spanHits?: number;
  /** 派生的构建/测试状态(命令模式 + span 状态,查询时计算)。 */
  buildStatus?: 'pass' | 'fail' | 'none';
  /** 人工标注。 */
  verdict?: 'pass' | 'partial' | 'fail';
  taskType?: 'feature' | 'fix' | 'change' | 'ask';
  note?: string;
}

/** SearchHit per docs/api.md. */
interface SearchHit {
  spanId: string;
  sessionId: string;
  kind: Span['kind'];
  name: string;
  toolName?: string;
  snippet: string;
  /** 首个命中的字段(驱动 UI 的 in/out/name 徽章)。 */
  matchedField?: 'input' | 'output' | 'name';
  /** 所属 session 的 cwd(下拉展示项目名用)。 */
  cwd?: string;
  /** 平台(claude-code/codex/kimi-code,驱动 UI 平台徽章)。 */
  source?: string;
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
/** 下拉 snippet 固定 20 字符,命中词居中。 */
const SNIPPET_LEN = 20;

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
    ...(row.verdict !== null ? { verdict: row.verdict } : {}),
    ...(row.taskType !== null ? { taskType: row.taskType } : {}),
    ...(row.note !== null ? { note: row.note } : {}),
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

/** Parse an optional boolean query param ('1'/'true' → true, '0'/'false' → false). */
function parseBoolParam(raw: string | undefined, name: string): boolean | string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return `${name} must be 1|true|0|false`;
}

/** Parse the optional `build` query param. */
function parseBuildParam(raw: string | undefined): { build?: 'pass' | 'fail' | 'none'; error?: string } {
  if (raw === undefined || raw === '') return {};
  if (raw === 'pass' || raw === 'fail' || raw === 'none') return { build: raw };
  return { error: 'build must be pass|fail|none' };
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
      // 固定 20 字符窗口,命中词尽量居中(词比窗长则从词头截)
      const room = Math.max(0, SNIPPET_LEN - token.length);
      const start = Math.max(0, at - Math.floor(room / 2));
      const prefix = start > 0 ? '…' : '';
      const body = field.slice(start, start + SNIPPET_LEN);
      const suffix = start + SNIPPET_LEN < field.length ? '…' : '';
      return `${prefix}${body}${suffix}`;
    }
  }
  const fallback = fields[0] ?? '';
  return fallback.length <= SNIPPET_LEN ? fallback : `${fallback.slice(0, SNIPPET_LEN)}…`;
}

function toSearchHit(span: Span, query: string): SearchHit {
  const sessionId = span.attributes[ATTR.SESSION_ID];
  const matchedField = firstMatchedField(span, query);
  const source = span.attributes[ATTR.SOURCE];
  return {
    spanId: span.spanId,
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    kind: span.kind,
    name: span.name,
    ...(span.toolName !== undefined ? { toolName: span.toolName } : {}),
    snippet: makeSnippet(span, query),
    ...(matchedField !== undefined ? { matchedField } : {}),
    ...(typeof source === 'string' ? { source } : {}),
    startTimeMs: span.startTimeMs,
  };
}

/** Which summary field the query hits first (input → output → name). */
function firstMatchedField(span: Span, query: string): 'input' | 'output' | 'name' | undefined {
  const token = query.match(/[\p{L}\p{N}_.-]+/u)?.[0];
  if (token === undefined) return undefined;
  const needle = token.toLowerCase();
  if (span.inputSummary?.toLowerCase().includes(needle)) return 'input';
  if (span.outputSummary?.toLowerCase().includes(needle)) return 'output';
  if (span.name.toLowerCase().includes(needle)) return 'name';
  return undefined;
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
    const cwd = c.req.query('cwd');
    const from = parseIntParam(c.req.query('from'), 'from', 0, 0);
    if (typeof from === 'string') return c.json({ error: from }, 400);
    const hasErrorRes = parseBoolParam(c.req.query('hasError'), 'hasError');
    if (typeof hasErrorRes === 'string') return c.json({ error: hasErrorRes }, 400);
    const spanQ = c.req.query('spanQ');
    const buildRes = parseBuildParam(c.req.query('build'));
    if (buildRes.error !== undefined) return c.json({ error: buildRes.error }, 400);
    const filter: ListSessionsFilter = {
      ...(sourceRes.source !== undefined ? { source: sourceRes.source } : {}),
      ...(q !== undefined && q !== '' ? { q } : {}),
      ...(cwd !== undefined && cwd !== '' ? { cwdPrefix: cwd } : {}),
      ...(from > 0 ? { fromMs: from } : {}),
      ...(hasErrorRes !== undefined ? { hasError: hasErrorRes } : {}),
      ...(spanQ !== undefined && spanQ.trim() !== '' ? { spanQ } : {}),
      ...(buildRes.build !== undefined ? { buildStatus: buildRes.build } : {}),
      limit,
      offset,
    };
    const sessions = store.listSessions(filter).map(toSessionSummary);
    const total = store.countSessions(filter);
    // spanQ 生效时附每 session 的命中数("N 处命中"徽章)
    if (spanQ !== undefined && spanQ.trim() !== '') {
      const hits = store.spanHitCounts(spanQ, sourceRes.source);
      for (const s of sessions) {
        const n = hits.get(s.sessionId);
        if (n !== undefined) s.spanHits = n;
      }
    }
    // 附每 session 的构建/测试派生状态
    const buildMap = store.buildStatusByIds(sessions.map((s) => s.sessionId));
    for (const s of sessions) {
      s.buildStatus = buildMap.get(s.sessionId) ?? 'none';
    }
    return c.json({ sessions, total });
  });

  /** Distinct cwd values with counts, optionally scoped to a source (cwd cascade). */
  app.get('/api/cwds', (c) => {
    const sourceRes = parseSourceParam(c.req.query('source'));
    if (sourceRes.error !== undefined) return c.json({ error: sourceRes.error }, 400);
    const cwds = store.listCwds(sourceRes.source);
    return c.json({ cwds });
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
    const summary = toSessionSummary(row);
    summary.buildStatus = store.buildStatusByIds([summary.sessionId]).get(summary.sessionId) ?? 'none';
    return c.json(summary);
  });

  /** 人工标注:写入 verdict / taskType / note(局部更新,null 清除)。 */
  app.put('/api/sessions/:sessionId/verdict', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (store.getSessionRow(sessionId) === undefined) {
      return c.json({ error: 'session not found' }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (body === null || typeof body !== 'object') {
      return c.json({ error: 'body must be an object' }, 400);
    }
    const b = body as Record<string, unknown>;
    const VERDICTS = ['pass', 'partial', 'fail'];
    const TASK_TYPES = ['feature', 'fix', 'change', 'ask'];
    const patch: Parameters<typeof store.setVerdict>[1] = {};
    if ('verdict' in b) {
      if (b.verdict !== null && !VERDICTS.includes(b.verdict as string)) {
        return c.json({ error: `verdict must be ${VERDICTS.join('|')}|null` }, 400);
      }
      patch.verdict = b.verdict as SessionRow['verdict'];
    }
    if ('taskType' in b) {
      if (b.taskType !== null && !TASK_TYPES.includes(b.taskType as string)) {
        return c.json({ error: `taskType must be ${TASK_TYPES.join('|')}|null` }, 400);
      }
      patch.taskType = b.taskType as SessionRow['taskType'];
    }
    if ('note' in b) {
      if (b.note !== null && typeof b.note !== 'string') {
        return c.json({ error: 'note must be a string|null' }, 400);
      }
      patch.note = (b.note as string | null)?.slice(0, 2000) ?? null;
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'nothing to update (verdict|taskType|note expected)' }, 400);
    }
    store.setVerdict(sessionId, patch);
    const row = store.getSessionRow(sessionId);
    if (row === undefined) return c.json({ error: 'session not found' }, 404);
    return c.json(toSessionSummary(row));
  });

  /** 成功率聚合(仅统计已标注 session)。 */
  app.get('/api/stats/success', (c) => {
    const groupBy = c.req.query('groupBy') ?? 'source';
    if (!['source', 'cwd', 'taskType', 'week'].includes(groupBy)) {
      return c.json({ error: 'groupBy must be source|cwd|taskType|week' }, 400);
    }
    return c.json({ stats: store.successStats(groupBy as 'source' | 'cwd' | 'taskType' | 'week') });
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

    // 多拉 10 倍,按 session 去重后截到 limit(每 session 只留一条代表命中)
    const spans = store.searchSpans(q, {
      ...(sourceRes.source !== undefined ? { source: sourceRes.source } : {}),
      limit: limit * 10,
    });
    const seenSessions = new Set<string>();
    const deduped: Span[] = [];
    for (const span of spans) {
      const sid = span.attributes[ATTR.SESSION_ID];
      const key = typeof sid === 'string' ? sid : span.spanId;
      if (seenSessions.has(key)) continue;
      seenSessions.add(key);
      deduped.push(span);
      if (deduped.length >= limit) break;
    }
    // 附 session cwd(下拉展示用项目名,替代无意义的 sessionId 前缀)
    const cwdBySession = new Map<string, string>();
    for (const span of deduped) {
      const sid = span.attributes[ATTR.SESSION_ID];
      if (typeof sid !== 'string' || cwdBySession.has(sid)) continue;
      const row = store.getSessionRow(sid);
      if (row?.cwd !== null && row?.cwd !== undefined) cwdBySession.set(sid, row.cwd);
    }
    return c.json({
      results: deduped.map((span) => {
        const hit = toSearchHit(span, q);
        const cwd = cwdBySession.get(hit.sessionId);
        return cwd !== undefined ? { ...hit, cwd } : hit;
      }),
    });
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
