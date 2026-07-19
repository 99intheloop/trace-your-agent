import type { SpanAttributeValue, SpanEvent, SpanKind, SpanStatus, Source, TokenUsage } from './types.js';

/**
 * Adapter contract — the implementation boundary for the Claude Code / Codex /
 * Kimi Code adapters (added in a later milestone), and the seam for future
 * live/proxy capture modes.
 *
 * Pipeline: `detect()` finds the agent's home directory (read-only!),
 * `discover()` enumerates session files, `parse()` turns one session file into
 * a stream of {@link RawEvent}s. The core ingest pipeline then feeds those
 * events into {@link SpanBuilder}, derives ids via `traceIdFor`/`spanIdFor`
 * (ids.ts), and persists results.
 *
 * Adapters MUST:
 * - treat the agent home as strictly read-only;
 * - emit events in file order;
 * - choose `sourceRowKey`s that are stable across re-runs, so span ids are
 *   idempotent (see ids.ts);
 * - when resuming from `fromOffset`, start at the first complete record at or
 *   after that byte offset (records are at-least-once; idempotent span ids
 *   make re-emitted rows harmless).
 */

export interface DetectedHome {
  source: Source;
  /** Absolute path of the detected agent home, e.g. `~/.claude`. */
  homeDir: string;
  /** Detected CLI/data-format version, when discoverable. */
  version?: string;
  /** Whether the home is readable by this process. */
  readable: boolean;
  /** Number of session record files seen at detection time, when countable. */
  sessionCount?: number;
}

/**
 * A sidecar record file that belongs to a session but is not a session itself
 * (e.g. a Claude Code subagent sidechain `agent-<id>.jsonl`). Sidechains are
 * parsed together with their owning session file and joined into its span tree.
 */
export interface SessionSidechainRef {
  /** Stable id of the subagent that produced this file (from the filename). */
  agentId: string;
  /** Absolute path of the sidechain record file. */
  filePath: string;
  /** Sibling metadata file (`agent-<id>.meta.json`), when present. */
  metaPath?: string;
}

export interface SessionRef {
  source: Source;
  /** The session id as assigned by the source system (becomes `session.id`). */
  sessionId: string;
  /** Absolute path of the session record file. */
  filePath: string;
  /** File mtime (ms) at discovery time. */
  mtime: number;
  /** File size (bytes) at discovery time. */
  size: number;
  /** Sidecar files (subagent sidechains) belonging to this session. */
  sidechains?: readonly SessionSidechainRef[];
}

export interface Adapter {
  readonly source: Source;
  /** Locate the agent home; `null` when the agent is not present on this machine. */
  detect(): Promise<DetectedHome | null>;
  /** Enumerate session record files under a detected home. */
  discover(home: DetectedHome): AsyncIterable<SessionRef>;
  /** Parse one session file into normalized events, resuming at `fromOffset`. */
  parse(session: SessionRef, fromOffset: number): AsyncIterable<RawEvent>;
}

/**
 * RawEvent — the normalized intermediate language between adapters and the
 * core ingest pipeline. Deliberately small: five verbs, nothing else.
 *
 * Keying: `key` is an adapter-chosen handle for a span while it is open
 * (e.g. a `tool_use` id, or `turn:<n>`). Keys only need to be unique among
 * simultaneously open spans; they never appear in the output. `parentKey`
 * refers to the key of a span that is open at the time of the `span.open`
 * event. `sourceRowKey` is a stable per-row key used with `spanIdFor`.
 */
export type RawEvent =
  | RawSessionMetaEvent
  | RawSpanOpenEvent
  | RawSpanAttrEvent
  | RawSpanEventEvent
  | RawSpanCloseEvent
  | RawLinkEvent;

/** Session-level metadata; adapters should emit it once, as early as possible. */
export interface RawSessionMetaEvent {
  type: 'session.meta';
  /** Working directory of the session, when recorded by the source. */
  cwd?: string;
  /** Session start time (ms since epoch), when recorded. */
  startedAtMs?: number;
  /** Extra session attributes, e.g. `{ 'gen_ai.request.model': 'claude-sonnet-4-5' }`. */
  attributes?: Record<string, SpanAttributeValue>;
}

/**
 * Open a span. The ingest pipeline turns this into `SpanBuilder.openSpan`,
 * computing `spanId = spanIdFor(traceId, sourceRowKey)` and, when `parentKey`
 * is given, wiring `parentSpanId` to the parent span's id.
 */
export interface RawSpanOpenEvent {
  type: 'span.open';
  /** Adapter-chosen handle for the span while it is open (e.g. tool_use id). */
  key: string;
  /** Key of the currently-open parent span; omit for root spans. */
  parentKey?: string;
  /** Stable, unique-per-row key within the session file (see ids.ts). */
  sourceRowKey: string;
  kind: SpanKind;
  name: string;
  startTimeMs: number;
  status?: SpanStatus;
  attributes?: Record<string, SpanAttributeValue>;
  events?: SpanEvent[];
  toolName?: string;
  agentName?: string;
  inputSummary?: string;
  /** Ref into the payload store (payloads/<sha256>.json) for full payloads. */
  payloadRef?: string;
}

/** Merge attributes into / append an event to a span that is still open. */
export interface RawSpanAttrEvent {
  type: 'span.attr';
  key: string;
  attributes: Record<string, SpanAttributeValue>;
}

export interface RawSpanEventEvent {
  type: 'span.event';
  key: string;
  event: SpanEvent;
}

/**
 * Close a span normally. Spans still open when `parse()` finishes are closed
 * by the pipeline via `SpanBuilder.closeAllIncomplete` with `incomplete: true`,
 * so adapters only emit this for genuinely observed ends.
 */
export interface RawSpanCloseEvent {
  type: 'span.close';
  key: string;
  endTimeMs: number;
  status?: SpanStatus;
  attributes?: Record<string, SpanAttributeValue>;
  /** Close-time events (e.g. first_token / stream_end latency markers). */
  events?: SpanEvent[];
  tokenUsage?: TokenUsage;
  outputSummary?: string;
  payloadRef?: string;
}

/**
 * A cross-span link (e.g. main agent notifying a detached background
 * subagent). Both endpoints reference span keys previously used in
 * `span.open`; the pipeline resolves them to span ids.
 */
export interface RawLinkEvent {
  type: 'link';
  fromKey: string;
  toKey: string;
  kind: 'NOTIFY' | 'MESSAGE';
}
