import { createHash } from 'node:crypto';
import type { Source } from './types.js';

/**
 * Deterministic identity helpers.
 *
 * Re-ingesting the same source data must produce the same ids, so ingestion is
 * idempotent and safe to re-run (e.g. after crash, or incremental re-reads).
 */

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * traceId for one recorded session: first 32 hex chars of
 * sha256(`${source}:${sessionId}`).
 */
export function traceIdFor(source: Source, sessionId: string): string {
  return sha256Hex(`${source}:${sessionId}`).slice(0, 32);
}

/**
 * spanId for one source row within a trace: first 16 hex chars of
 * sha256(`${traceId}:${sourceRowKey}`).
 *
 * `sourceRowKey` must uniquely and stably identify the row/event inside the
 * session file (e.g. a uuid from the log line, or `${file}:${lineNo}`).
 * Same source row + same session => same spanId, forever.
 */
export function spanIdFor(traceId: string, sourceRowKey: string): string {
  return sha256Hex(`${traceId}:${sourceRowKey}`).slice(0, 16);
}
