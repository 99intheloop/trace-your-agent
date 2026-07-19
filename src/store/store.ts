import Database from 'better-sqlite3';
import { ATTR, type Link, type Source, type Span, type SpanEvent, type SpanKind } from '../core/types.js';
import { buildCommandSql, reduceBuildStatus, type BuildStatus } from './build-status.js';
import { estimateCostUsd } from './pricing.js';
import { SCHEMA_SQL } from './schema.js';

/**
 * SQLite-backed span store.
 *
 * `spans` is the single source of truth. `sessions` is a MATERIALIZED
 * AGGREGATE: it is rebuilt from `spans` (via {@link TraceStore.recomputeSession})
 * after every insert batch — not maintained incrementally — so re-ingesting a
 * session can never drift the counters. The exception is `cwd`, which comes
 * from adapters' `session.meta` events via {@link TraceStore.upsertSessionMeta}
 * and is preserved across recomputes.
 *
 * Cost: `total_cost_usd` is summed per-span with the built-in price table
 * (pricing.ts — prices go stale, treat as estimate).
 */

export interface SessionRow {
  sessionId: string;
  source: string;
  cwd: string | null;
  startedAtMs: number | null;
  spanCount: number;
  agentCount: number;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  errorCount: number;
  joinQualityStats: Record<string, number>;
}

export interface ListSessionsFilter {
  source?: Source;
  /** Substring match on session_id or cwd (used by the HTTP API's `q` param). */
  q?: string;
  /** Only sessions started at/after this ms timestamp. */
  fromMs?: number;
  /** Only sessions started at/before this ms timestamp. */
  toMs?: number;
  /** cwd equals this path or sits under it (boundary-aware prefix match). */
  cwdPrefix?: string;
  /** true: only sessions with errors; false: only sessions without errors. */
  hasError?: boolean;
  /** Full-text query over spans — only sessions containing a hit span. */
  spanQ?: string;
  /** 派生的构建/测试信号(查询时计算,不落库):pass / fail / none。 */
  buildStatus?: 'pass' | 'fail' | 'none';
  orderBy?: 'started_at' | 'span_count' | 'total_tokens' | 'total_cost';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface SearchSpansFilter {
  sessionId?: string;
  traceId?: string;
  source?: Source;
  kind?: SpanKind;
  limit?: number;
}

export interface SessionStats {
  sessionId: string;
  spanCount: number;
  byKind: Partial<Record<SpanKind, number>>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  errorCount: number;
  incompleteCount: number;
  topTools: Array<{ toolName: string; count: number }>;
}

interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  kind: string;
  name: string;
  start_time_ms: number;
  duration_ms: number;
  status_code: string;
  status_message: string | null;
  session_id: string;
  source: string;
  agent_id: string | null;
  tool_name: string | null;
  token_input: number | null;
  token_output: number | null;
  token_cache_read: number | null;
  token_cache_write: number | null;
  attributes: string;
  events: string | null;
  input_summary: string | null;
  output_summary: string | null;
  payload_ref: string | null;
  join_quality: string | null;
  detached: number;
  incomplete: number;
  approx: number;
}

export class TraceStore {
  private readonly db: Database.Database;

  /** @param dbPath file path, or `:memory:` for tests. */
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Insert spans idempotently (INSERT OR REPLACE keyed by span_id) inside one
   * transaction, then recompute the affected session aggregates.
   * `session.id` and `source` are read from span attributes (see ATTR).
   */
  insertSpans(spans: readonly Span[]): number {
    if (spans.length === 0) return 0;
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO spans (
        trace_id, span_id, parent_span_id, kind, name, start_time_ms, duration_ms,
        status_code, status_message, session_id, source, agent_id, tool_name,
        token_input, token_output, token_cache_read, token_cache_write,
        attributes, events, input_summary, output_summary, payload_ref,
        join_quality, detached, incomplete, approx
      ) VALUES (
        @traceId, @spanId, @parentSpanId, @kind, @name, @startTimeMs, @durationMs,
        @statusCode, @statusMessage, @sessionId, @source, @agentId, @toolName,
        @tokenInput, @tokenOutput, @tokenCacheRead, @tokenCacheWrite,
        @attributes, @events, @inputSummary, @outputSummary, @payloadRef,
        @joinQuality, @detached, @incomplete, @approx
      )`);
    const ftsDelete = this.db.prepare('DELETE FROM spans_fts WHERE span_id = ?');
    const ftsInsert = this.db.prepare(
      'INSERT INTO spans_fts (name, input_summary, output_summary, tool_name, span_id) VALUES (?, ?, ?, ?, ?)',
    );

    const sessionIds = new Set<string>();
    const run = this.db.transaction((batch: readonly Span[]) => {
      for (const span of batch) {
        const row = spanToRow(span);
        insert.run(row);
        ftsDelete.run(span.spanId);
        ftsInsert.run(
          span.name,
          span.inputSummary ?? null,
          span.outputSummary ?? null,
          span.toolName ?? null,
          span.spanId,
        );
        sessionIds.add(row.sessionId as string);
      }
    });
    run(spans);
    for (const sessionId of sessionIds) this.recomputeSession(sessionId);
    return spans.length;
  }

  /**
   * Null out `payload_ref` on spans pointing at payloads that were deleted
   * (e.g. by `tya prune`). Returns the number of spans updated.
   */
  clearPayloadRefs(refs: readonly string[]): number {
    if (refs.length === 0) return 0;
    const stmt = this.db.prepare('UPDATE spans SET payload_ref = NULL WHERE payload_ref = ?');
    let changed = 0;
    const run = this.db.transaction((list: readonly string[]) => {
      for (const ref of list) changed += stmt.run(ref).changes;
    });
    run(refs);
    return changed;
  }

  /** Reclaim free pages and rebuild the database file (must not run in a transaction). */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  /** Insert links idempotently (duplicate endpoint pairs are ignored). */
  insertLinks(links: readonly Link[]): number {
    if (links.length === 0) return 0;
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO links (from_span_id, to_span_id, kind) VALUES (?, ?, ?)',
    );
    const run = this.db.transaction((batch: readonly Link[]) => {
      for (const link of batch) stmt.run(link.fromSpanId, link.toSpanId, link.kind);
    });
    run(links);
    return links.length;
  }

  /**
   * Record session-level metadata from an adapter `session.meta` event.
   * Only provided fields are updated; the row is created if missing.
   */
  upsertSessionMeta(
    sessionId: string,
    source: Source,
    meta: { cwd?: string; startedAtMs?: number },
  ): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, source, cwd, started_at_ms)
         VALUES (@sessionId, @source, @cwd, @startedAtMs)
         ON CONFLICT(session_id) DO UPDATE SET
           source = excluded.source,
           cwd = COALESCE(excluded.cwd, sessions.cwd),
           started_at_ms = COALESCE(excluded.started_at_ms, sessions.started_at_ms)`,
      )
      .run({
        sessionId,
        source,
        cwd: meta.cwd ?? null,
        startedAtMs: meta.startedAtMs ?? null,
      });
  }

  /** Rebuild the materialized aggregate row for one session from `spans`. */
  recomputeSession(sessionId: string): void {
    const agg = this.db
      .prepare(
        `SELECT
           COUNT(*) AS span_count,
           COUNT(DISTINCT agent_id) AS agent_count,
           SUM(CASE WHEN kind = 'AGENT_TURN' THEN 1 ELSE 0 END) AS turn_count,
           COALESCE(SUM(token_input), 0) AS total_input,
           COALESCE(SUM(token_output), 0) AS total_output,
           SUM(CASE WHEN status_code = 'error' THEN 1 ELSE 0 END) AS error_count,
           MIN(start_time_ms) AS started_at_ms,
           MIN(source) AS source
         FROM spans WHERE session_id = ?`,
      )
      .get(sessionId) as {
      span_count: number;
      agent_count: number | null;
      turn_count: number | null;
      total_input: number;
      total_output: number;
      error_count: number | null;
      started_at_ms: number | null;
      source: string | null;
    };

    const jqRows = this.db
      .prepare(
        `SELECT COALESCE(join_quality, 'none') AS jq, COUNT(*) AS n
         FROM spans WHERE session_id = ? GROUP BY jq`,
      )
      .all(sessionId) as Array<{ jq: string; n: number }>;
    const joinQualityStats: Record<string, number> = {};
    for (const { jq, n } of jqRows) joinQualityStats[jq] = n;

    let totalCostUsd = 0;
    const costRows = this.db
      .prepare(
        `SELECT attributes, token_input, token_output, token_cache_read, token_cache_write
         FROM spans WHERE session_id = ? AND token_input IS NOT NULL`,
      )
      .all(sessionId) as Array<{
      attributes: string;
      token_input: number;
      token_output: number | null;
      token_cache_read: number | null;
      token_cache_write: number | null;
    }>;
    for (const row of costRows) {
      const attrs = JSON.parse(row.attributes) as Record<string, unknown>;
      const model = attrs[ATTR.GEN_AI_MODEL];
      if (typeof model !== 'string') continue;
      const cost = estimateCostUsd(
        {
          inputTokens: row.token_input,
          outputTokens: row.token_output ?? 0,
          cacheReadTokens: row.token_cache_read ?? 0,
          cacheWriteTokens: row.token_cache_write ?? 0,
        },
        model,
      );
      if (cost !== undefined) totalCostUsd += cost;
    }

    if (agg.span_count === 0) {
      this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO sessions (
           session_id, source, started_at_ms, span_count, agent_count, turn_count,
           total_input_tokens, total_output_tokens, total_cost_usd, error_count, join_quality_stats
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           source = excluded.source,
           started_at_ms = COALESCE(sessions.started_at_ms, excluded.started_at_ms),
           span_count = excluded.span_count,
           agent_count = excluded.agent_count,
           turn_count = excluded.turn_count,
           total_input_tokens = excluded.total_input_tokens,
           total_output_tokens = excluded.total_output_tokens,
           total_cost_usd = excluded.total_cost_usd,
           error_count = excluded.error_count,
           join_quality_stats = excluded.join_quality_stats`,
      )
      .run(
        sessionId,
        agg.source ?? 'unknown',
        agg.started_at_ms,
        agg.span_count,
        agg.agent_count ?? 0,
        agg.turn_count ?? 0,
        agg.total_input,
        agg.total_output,
        totalCostUsd,
        agg.error_count ?? 0,
        JSON.stringify(joinQualityStats),
      );
  }

  listSessions(filter: ListSessionsFilter = {}): SessionRow[] {
    const { where, params } = sessionWhere(filter);
    const orderByColumns: Record<NonNullable<ListSessionsFilter['orderBy']>, string> = {
      started_at: 'started_at_ms',
      span_count: 'span_count',
      total_tokens: '(total_input_tokens + total_output_tokens)',
      total_cost: 'total_cost_usd',
    };
    const orderBy = orderByColumns[filter.orderBy ?? 'started_at'];
    const order = filter.order === 'asc' ? 'ASC' : 'DESC';
    let sql = `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy} ${order}`;
    if (filter.limit !== undefined) {
      sql += ' LIMIT @limit';
      params.limit = filter.limit;
      if (filter.offset !== undefined) {
        sql += ' OFFSET @offset';
        params.offset = filter.offset;
      }
    }
    const rows = this.db.prepare(sql).all(params) as Array<Record<string, unknown>>;
    return rows.map(rowToSession);
  }

  /** Total sessions matching the filter (ignores order/limit/offset). */
  countSessions(filter: ListSessionsFilter = {}): number {
    const { where, params } = sessionWhere(filter);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      )
      .get(params) as { n: number };
    return row.n;
  }

  /** Distinct cwd values with session counts (drives the UI cwd cascade). */
  listCwds(source?: Source): Array<{ cwd: string; count: number }> {
    const rows = this.db
      .prepare(
        `SELECT cwd, COUNT(*) AS n FROM sessions
         WHERE cwd IS NOT NULL ${source !== undefined ? 'AND source = @source' : ''}
         GROUP BY cwd ORDER BY n DESC, cwd ASC`,
      )
      .all(source !== undefined ? { source } : {}) as Array<{ cwd: string; n: number }>;
    return rows.map((r) => ({ cwd: r.cwd, count: r.n }));
  }

  /** Per-session FTS hit counts (the "N 处命中" badge for spanQ-filtered lists). */
  spanHitCounts(query: string, source?: Source): Map<string, number> {
    const ftsQuery = toFtsQuery(query);
    const map = new Map<string, number>();
    if (ftsQuery === null) return map;
    const rows = this.db
      .prepare(
        `SELECT sp.session_id AS sid, COUNT(*) AS n
         FROM spans sp
         JOIN spans_fts ON spans_fts.span_id = sp.span_id
         WHERE spans_fts MATCH @q ${source !== undefined ? 'AND sp.source = @source' : ''}
         GROUP BY sp.session_id`,
      )
      .all(source !== undefined ? { q: ftsQuery, source } : { q: ftsQuery }) as Array<{
      sid: string;
      n: number;
    }>;
    for (const r of rows) map.set(r.sid, r.n);
    return map;
  }

  /**
   * 派生每个 session 的构建/测试状态(捷径版:命令模式 + 现有 span 状态)。
   * 返回 Map<sessionId, 'pass'|'fail'>;不在 Map 里的 session 即 'none'。
   */
  buildStatusByIds(ids: readonly string[]): Map<string, Exclude<BuildStatus, 'none'>> {
    const map = new Map<string, Exclude<BuildStatus, 'none'>>();
    if (ids.length === 0) return map;
    const cmd = buildCommandSql();
    const holders = ids.map((_, i) => `@bs_id${i}`).join(',');
    const rows = this.db
      .prepare(
        `SELECT session_id AS sid,
                COUNT(*) AS n,
                SUM(CASE WHEN status_code = 'error' THEN 1 ELSE 0 END) AS fails
         FROM spans
         WHERE kind = 'TOOL_CALL' AND ${cmd.where} AND session_id IN (${holders})
         GROUP BY session_id`,
      )
      .all({
        ...cmd.params,
        ...Object.fromEntries(ids.map((id, i) => [`bs_id${i}`, id])),
      }) as Array<{ sid: string; n: number; fails: number }>;
    for (const r of rows) {
      map.set(r.sid, reduceBuildStatus(r.n, r.fails) as Exclude<BuildStatus, 'none'>);
    }
    return map;
  }

  /** All spans of a session, by session.id OR traceId, ordered by start time. */
  getSessionSpans(sessionIdOrTraceId: string): Span[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM spans WHERE session_id = ? OR trace_id = ? ORDER BY start_time_ms ASC, span_id ASC',
      )
      .all(sessionIdOrTraceId, sessionIdOrTraceId) as SpanRow[];
    return rows.map(rowToSpan);
  }

  /** Full-text search over name/summaries/tool name, plus structured filters. */
  searchSpans(query: string, filters: SearchSpansFilter = {}): Span[] {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery === null) return [];
    const where = ['spans_fts MATCH @ftsQuery'];
    const params: Record<string, unknown> = { ftsQuery };
    if (filters.sessionId !== undefined) {
      where.push('s.session_id = @sessionId');
      params.sessionId = filters.sessionId;
    }
    if (filters.traceId !== undefined) {
      where.push('s.trace_id = @traceId');
      params.traceId = filters.traceId;
    }
    if (filters.source !== undefined) {
      where.push('s.source = @source');
      params.source = filters.source;
    }
    if (filters.kind !== undefined) {
      where.push('s.kind = @kind');
      params.kind = filters.kind;
    }
    const limit = filters.limit ?? 100;
    params.limit = limit;
    const rows = this.db
      .prepare(
        `SELECT s.* FROM spans_fts
         JOIN spans s ON s.span_id = spans_fts.span_id
         WHERE ${where.join(' AND ')}
         ORDER BY s.start_time_ms DESC
         LIMIT @limit`,
      )
      .all(params) as SpanRow[];
    return rows.map(rowToSpan);
  }

  /** Links whose endpoints belong to the given trace. */
  getLinks(traceId: string): Link[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT l.from_span_id, l.to_span_id, l.kind
         FROM links l
         JOIN spans sf ON sf.span_id = l.from_span_id
         JOIN spans st ON st.span_id = l.to_span_id
         WHERE sf.trace_id = ? AND st.trace_id = ?
         ORDER BY l.from_span_id`,
      )
      .all(traceId, traceId) as Array<{ from_span_id: string; to_span_id: string; kind: string }>;
    return rows.map((r) => ({
      fromSpanId: r.from_span_id,
      toSpanId: r.to_span_id,
      kind: r.kind as Link['kind'],
    }));
  }

  /** Live-computed stats for one session (not the materialized row). */
  getStats(sessionId: string): SessionStats {
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) AS span_count,
           COALESCE(SUM(token_input), 0) AS input,
           COALESCE(SUM(token_output), 0) AS output,
           COALESCE(SUM(token_cache_read), 0) AS cache_read,
           COALESCE(SUM(token_cache_write), 0) AS cache_write,
           SUM(CASE WHEN status_code = 'error' THEN 1 ELSE 0 END) AS errors,
           SUM(CASE WHEN incomplete = 1 THEN 1 ELSE 0 END) AS incomplete
         FROM spans WHERE session_id = ?`,
      )
      .get(sessionId) as {
      span_count: number;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      errors: number | null;
      incomplete: number | null;
    };

    const byKind: Partial<Record<SpanKind, number>> = {};
    const kindRows = this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM spans WHERE session_id = ? GROUP BY kind')
      .all(sessionId) as Array<{ kind: string; n: number }>;
    for (const { kind, n } of kindRows) byKind[kind as SpanKind] = n;

    const topTools = this.db
      .prepare(
        `SELECT tool_name AS toolName, COUNT(*) AS count FROM spans
         WHERE session_id = ? AND tool_name IS NOT NULL
         GROUP BY tool_name ORDER BY count DESC, toolName ASC LIMIT 10`,
      )
      .all(sessionId) as Array<{ toolName: string; count: number }>;

    return {
      sessionId,
      spanCount: totals.span_count,
      byKind,
      totalInputTokens: totals.input,
      totalOutputTokens: totals.output,
      totalCacheReadTokens: totals.cache_read,
      totalCacheWriteTokens: totals.cache_write,
      totalCostUsd: this.getSessionRow(sessionId)?.totalCostUsd ?? 0,
      errorCount: totals.errors ?? 0,
      incompleteCount: totals.incomplete ?? 0,
      topTools,
    };
  }

  getSessionRow(sessionId: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : rowToSession(row);
  }
}

/** Turn a free-text query into a safe FTS5 MATCH expression (AND of quoted tokens). */
function toFtsQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_.-]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' ');
}

/** WHERE clauses shared by listSessions/countSessions (order/limit/offset excluded). */
function sessionWhere(filter: ListSessionsFilter): { where: string[]; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.source !== undefined) {
    where.push('source = @source');
    params.source = filter.source;
  }
  if (filter.q !== undefined && filter.q !== '') {
    where.push('(session_id LIKE @q OR cwd LIKE @q)');
    params.q = `%${filter.q}%`;
  }
  if (filter.fromMs !== undefined) {
    where.push('started_at_ms >= @fromMs');
    params.fromMs = filter.fromMs;
  }
  if (filter.toMs !== undefined) {
    where.push('started_at_ms <= @toMs');
    params.toMs = filter.toMs;
  }
  if (filter.cwdPrefix !== undefined && filter.cwdPrefix !== '') {
    // Exact dir or a descendant — the trailing-slash prefix prevents
    // `/a/b` from matching `/a/bc`.
    where.push(`(cwd = @cwdExact OR cwd LIKE @cwdPrefix ESCAPE '\\')`);
    params.cwdExact = filter.cwdPrefix;
    params.cwdPrefix = `${escapeLike(filter.cwdPrefix)}/%`;
  }
  if (filter.hasError !== undefined) {
    where.push(filter.hasError ? 'error_count > 0' : 'error_count = 0');
  }
  if (filter.spanQ !== undefined && filter.spanQ !== '') {
    const ftsQuery = toFtsQuery(filter.spanQ);
    if (ftsQuery === null) {
      // 无可匹配词元(纯符号输入)→ 结果为空,但查询必须合法
      where.push('1 = 0');
    } else {
      where.push(
        `session_id IN (
          SELECT sp.session_id FROM spans sp
          JOIN spans_fts ON spans_fts.span_id = sp.span_id
          WHERE spans_fts MATCH @spanQ
        )`,
      );
      params.spanQ = ftsQuery;
    }
  }
  if (filter.buildStatus !== undefined) {
    const cmd = buildCommandSql();
    Object.assign(params, cmd.params);
    if (filter.buildStatus === 'none') {
      where.push(
        `session_id NOT IN (SELECT session_id FROM spans WHERE kind = 'TOOL_CALL' AND ${cmd.where})`,
      );
    } else {
      const having =
        filter.buildStatus === 'fail'
          ? `SUM(CASE WHEN status_code = 'error' THEN 1 ELSE 0 END) > 0`
          : `SUM(CASE WHEN status_code = 'error' THEN 1 ELSE 0 END) = 0`;
      where.push(
        `session_id IN (
          SELECT session_id FROM spans WHERE kind = 'TOOL_CALL' AND ${cmd.where}
          GROUP BY session_id HAVING ${having}
        )`,
      );
    }
  }
  return { where, params };
}

/** Escape LIKE wildcards (`%`, `_`) and the escape char itself. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function spanToRow(span: Span): Record<string, unknown> {
  const attr = span.attributes;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const bool = (v: unknown): number => (v === true ? 1 : 0);
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? null,
    kind: span.kind,
    name: span.name,
    startTimeMs: span.startTimeMs,
    durationMs: span.durationMs,
    statusCode: span.status.code,
    statusMessage: span.status.message ?? null,
    sessionId: str(attr[ATTR.SESSION_ID]) ?? '',
    source: str(attr[ATTR.SOURCE]) ?? 'unknown',
    agentId: str(attr[ATTR.AGENT_ID]),
    toolName: span.toolName ?? null,
    tokenInput: span.tokenUsage?.inputTokens ?? null,
    tokenOutput: span.tokenUsage?.outputTokens ?? null,
    tokenCacheRead: span.tokenUsage?.cacheReadTokens ?? null,
    tokenCacheWrite: span.tokenUsage?.cacheWriteTokens ?? null,
    attributes: JSON.stringify(attr),
    events: span.events ? JSON.stringify(span.events) : null,
    inputSummary: span.inputSummary ?? null,
    outputSummary: span.outputSummary ?? null,
    payloadRef: span.payloadRef ?? null,
    joinQuality: str(attr[ATTR.JOIN_QUALITY]),
    detached: bool(attr[ATTR.DETACHED]),
    incomplete: bool(attr[ATTR.INCOMPLETE]),
    approx: bool(attr[ATTR.APPROX]),
  };
}

function rowToSpan(row: SpanRow): Span {
  const span: Span = {
    traceId: row.trace_id,
    spanId: row.span_id,
    kind: row.kind as Span['kind'],
    name: row.name,
    startTimeMs: row.start_time_ms,
    durationMs: row.duration_ms,
    status: {
      code: row.status_code as Span['status']['code'],
      ...(row.status_message !== null ? { message: row.status_message } : {}),
    },
    attributes: JSON.parse(row.attributes) as Span['attributes'],
  };
  if (row.parent_span_id !== null) span.parentSpanId = row.parent_span_id;
  if (row.events !== null) span.events = JSON.parse(row.events) as SpanEvent[];
  if (row.token_input !== null || row.token_output !== null) {
    span.tokenUsage = {
      inputTokens: row.token_input ?? 0,
      outputTokens: row.token_output ?? 0,
      ...(row.token_cache_read !== null ? { cacheReadTokens: row.token_cache_read } : {}),
      ...(row.token_cache_write !== null ? { cacheWriteTokens: row.token_cache_write } : {}),
    };
  }
  if (row.tool_name !== null) span.toolName = row.tool_name;
  if (row.input_summary !== null) span.inputSummary = row.input_summary;
  if (row.output_summary !== null) span.outputSummary = row.output_summary;
  if (row.payload_ref !== null) span.payloadRef = row.payload_ref;
  const agentName = span.attributes['agent.name'];
  if (typeof agentName === 'string') span.agentName = agentName;
  return span;
}

function rowToSession(row: Record<string, unknown>): SessionRow {
  return {
    sessionId: row.session_id as string,
    source: row.source as string,
    cwd: (row.cwd as string | null) ?? null,
    startedAtMs: (row.started_at_ms as number | null) ?? null,
    spanCount: row.span_count as number,
    agentCount: row.agent_count as number,
    turnCount: row.turn_count as number,
    totalInputTokens: row.total_input_tokens as number,
    totalOutputTokens: row.total_output_tokens as number,
    totalCostUsd: row.total_cost_usd as number,
    errorCount: row.error_count as number,
    joinQualityStats: JSON.parse((row.join_quality_stats as string) ?? '{}') as Record<string, number>,
  };
}
