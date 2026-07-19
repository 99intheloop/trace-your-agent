/**
 * Low-level kimi-code wire.jsonl reading (v1 + v2 share this shell — see FORMAT.md).
 *
 * A wire file is JSONL: one flat `{type, time?, ...payload}` record per line,
 * first line is always `{"type":"metadata","protocol_version","created_at"}`.
 * The final line may be torn (crash mid-flush) and is dropped, matching
 * kimi's own reader.
 */

export interface WireRecord {
  readonly type: string;
  readonly time?: number;
  readonly [key: string]: unknown;
}

/** One parsed record plus the byte offset of its line start within its file. */
export interface ParsedWireLine {
  readonly record: WireRecord;
  readonly byteOffset: number;
}

export type WireEngine = 'v1' | 'v2';

export interface WireProtocol {
  readonly version: string;
  readonly engine: WireEngine;
}

/** Thrown when a wire file's protocol_version is outside the known 1.x lineage. */
export class UnknownWireProtocolError extends Error {
  readonly protocolVersion: string;

  constructor(protocolVersion: string, filePath: string) {
    super(`kimi-code: unknown wire protocol_version "${protocolVersion}" in ${filePath}`);
    this.name = 'UnknownWireProtocolError';
    this.protocolVersion = protocolVersion;
  }
}

/**
 * Map a `protocol_version` string to an engine generation.
 *
 * The wire protocol is a single 1.0 → 1.5 lineage shared by both engines
 * (FORMAT.md §2): v1 (packages/agent-core) currently writes 1.4, v2
 * (agent-core-v2) writes 1.5. Anything outside 1.0–1.5 is unknown.
 */
export function classifyProtocolVersion(version: string): WireProtocol | null {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (match === null) return null;
  const major = Number(match[1] ?? Number.NaN);
  const minor = Number(match[2] ?? Number.NaN);
  if (major !== 1 || minor < 0 || minor > 5) return null;
  return { version, engine: minor >= 5 ? 'v2' : 'v1' };
}

/**
 * Parse a wire.jsonl buffer into records, keeping only lines whose byte offset
 * is `>= fromOffset` (incremental resume: a cursor landing mid-line skips to
 * the next complete record, per the adapter contract).
 *
 * Tolerates a torn trailing line and silently skips any other unparseable
 * line — a trace tool ingests what it can rather than failing the session.
 */
export function parseWireJsonl(buf: Buffer, fromOffset: number): ParsedWireLine[] {
  const out: ParsedWireLine[] = [];
  let start = 0;
  while (start < buf.length) {
    const newline = buf.indexOf(0x0a, start);
    const end = newline === -1 ? buf.length : newline;
    if (end > start && start >= fromOffset) {
      let line = buf.toString('utf8', start, end);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) {
        try {
          const record = JSON.parse(line) as WireRecord;
          if (
            record !== null &&
            typeof record === 'object' &&
            !Array.isArray(record) &&
            typeof record.type === 'string'
          ) {
            out.push({ record, byteOffset: start });
          }
        } catch {
          // Torn trailing line (crash mid-flush) or corrupt row — skip.
        }
      }
    }
    if (newline === -1) break;
    start = end + 1;
  }
  return out;
}

// --- Untyped record field accessors (wire records are flat, payload varies) ---

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}
