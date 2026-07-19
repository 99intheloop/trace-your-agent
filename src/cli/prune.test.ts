import { mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Span } from '../core/types.js';
import { TraceStore } from '../store/store.js';
import { prunePayloads } from './prune.js';

let dir: string;
let payloadsDir: string;
let store: TraceStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tya-prune-'));
  payloadsDir = join(dir, 'payloads');
  mkdirSync(payloadsDir, { recursive: true });
  store = new TraceStore(':memory:');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function makePayload(content: string, ageDays: number): string {
  const hash = createHash('sha256').update(content).digest('hex');
  const filePath = join(payloadsDir, `${hash}.json`);
  writeFileSync(filePath, content, 'utf8');
  const mtime = new Date(NOW - ageDays * DAY);
  utimesSync(filePath, mtime, mtime);
  return `payloads/${hash}.json`;
}

function spanWithPayload(ref: string): Span {
  return {
    traceId: 'a'.repeat(32),
    spanId: ref.slice('payloads/'.length, 'payloads/'.length + 16),
    kind: 'TOOL_CALL',
    name: 'Bash',
    startTimeMs: NOW,
    durationMs: 1,
    status: { code: 'ok' },
    attributes: { 'session.id': 'sess-1', source: 'claude-code' },
    payloadRef: ref,
  };
}

describe('prunePayloads', () => {
  it('dry-run reports but deletes nothing and leaves the DB untouched', () => {
    const oldRef = makePayload('{"old":true}', 40);
    makePayload('{"new":true}', 2);
    const result = prunePayloads({ payloadsDir, store, olderDays: 30, dryRun: true, now: NOW });
    expect(result.scanned).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.deletedRefs).toEqual([oldRef]);
    expect(result.refsCleared).toBe(0);
    expect(readdirSync(payloadsDir)).toHaveLength(2);
  });

  it('deletes old payloads, clears their refs in the store, keeps new ones', () => {
    const oldRef = makePayload('{"old":true}', 40);
    const newRef = makePayload('{"new":true}', 2);
    store.insertSpans([spanWithPayload(oldRef), spanWithPayload(newRef)]);

    const result = prunePayloads({ payloadsDir, store, olderDays: 30, now: NOW });
    expect(result.matched).toBe(1);
    expect(result.refsCleared).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(readdirSync(payloadsDir)).toHaveLength(1);

    const spans = store.getSessionSpans('sess-1');
    const oldSpan = spans.find((s) => s.spanId === oldRef.slice(9, 25));
    const newSpan = spans.find((s) => s.spanId === newRef.slice(9, 25));
    expect(oldSpan?.payloadRef).toBeUndefined();
    expect(newSpan?.payloadRef).toBe(newRef);
  });

  it('handles a missing payloads directory', () => {
    const result = prunePayloads({
      payloadsDir: join(dir, 'does-not-exist'),
      store,
      olderDays: 30,
      now: NOW,
    });
    expect(result.scanned).toBe(0);
    expect(result.matched).toBe(0);
  });
});
