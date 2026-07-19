import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PayloadStore } from './payload-store.js';

describe('PayloadStore', () => {
  let home: string;
  let store: PayloadStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tya-payload-'));
    store = new PayloadStore(home);
    // ensureTyaHome would create this; tests construct PayloadStore directly.
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('put writes payloads/<sha256>.json and returns the ref; get reads it back', () => {
    const obj = { hello: 'world', n: 1 };
    const ref = store.put(obj);
    expect(ref).toMatch(/^payloads\/[0-9a-f]{64}\.json$/);
    expect(store.get(ref)).toEqual(obj);
    expect(store.has(ref)).toBe(true);
  });

  it('is content-addressed: same content, same ref, single file', () => {
    const a = store.put({ x: [1, 2, 3] });
    const b = store.put({ x: [1, 2, 3] });
    expect(a).toBe(b);
  });

  it('redacts secrets before writing', () => {
    const ref = store.put({ text: 'api_key=sk-live-1234567890' });
    const raw = readFileSync(join(home, ref), 'utf8');
    expect(raw).not.toContain('sk-live-1234567890');
    expect(raw).toContain('[REDACTED]');
  });

  it('rejects invalid refs', () => {
    expect(() => store.get('payloads/../../etc/passwd')).toThrow(/invalid payload ref/);
    expect(() => store.get('nope')).toThrow(/invalid payload ref/);
  });
});
