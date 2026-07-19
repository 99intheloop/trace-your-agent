/**
 * SQLite schema (better-sqlite3). All DDL is idempotent; `store.ts` runs this
 * on open. Single migration step for now — schema_version 1.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS spans (
  trace_id           TEXT NOT NULL,
  span_id            TEXT PRIMARY KEY,
  parent_span_id     TEXT,
  kind               TEXT NOT NULL,
  name               TEXT NOT NULL,
  start_time_ms      INTEGER NOT NULL,
  duration_ms        INTEGER NOT NULL,
  status_code        TEXT NOT NULL,
  status_message     TEXT,
  session_id         TEXT NOT NULL,
  source             TEXT NOT NULL,
  agent_id           TEXT,
  tool_name          TEXT,
  token_input        INTEGER,
  token_output       INTEGER,
  token_cache_read   INTEGER,
  token_cache_write  INTEGER,
  attributes         TEXT NOT NULL DEFAULT '{}',
  events             TEXT,
  input_summary      TEXT,
  output_summary     TEXT,
  payload_ref        TEXT,
  join_quality       TEXT,
  detached           INTEGER NOT NULL DEFAULT 0,
  incomplete         INTEGER NOT NULL DEFAULT 0,
  approx             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_spans_trace   ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id, start_time_ms);
CREATE INDEX IF NOT EXISTS idx_spans_parent  ON spans(parent_span_id);
CREATE INDEX IF NOT EXISTS idx_spans_source  ON spans(source, start_time_ms);

CREATE TABLE IF NOT EXISTS links (
  from_span_id TEXT NOT NULL,
  to_span_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  PRIMARY KEY (from_span_id, to_span_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_span_id);

CREATE TABLE IF NOT EXISTS sessions (
  session_id           TEXT PRIMARY KEY,
  source               TEXT NOT NULL,
  cwd                  TEXT,
  started_at_ms        INTEGER,
  span_count           INTEGER NOT NULL DEFAULT 0,
  agent_count          INTEGER NOT NULL DEFAULT 0,
  turn_count           INTEGER NOT NULL DEFAULT 0,
  total_input_tokens   INTEGER NOT NULL DEFAULT 0,
  total_output_tokens  INTEGER NOT NULL DEFAULT 0,
  total_cost_usd       REAL NOT NULL DEFAULT 0,
  error_count          INTEGER NOT NULL DEFAULT 0,
  join_quality_stats   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source, started_at_ms);

-- Standalone FTS5 table (span_id stored UNINDEXED to join back to spans).
-- Kept in sync by TraceStore.insertSpans: delete-by-span_id then re-insert.
CREATE VIRTUAL TABLE IF NOT EXISTS spans_fts USING fts5(
  name,
  input_summary,
  output_summary,
  tool_name,
  span_id UNINDEXED
);
`;
