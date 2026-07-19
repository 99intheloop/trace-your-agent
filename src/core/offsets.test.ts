import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OffsetStore } from './offsets.js';

describe('OffsetStore', () => {
  let home: string;
  let store: OffsetStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tya-offsets-'));
    store = new OffsetStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns undefined for unknown files', () => {
    expect(store.get('/a/b.jsonl')).toBeUndefined();
  });

  it('persists cursors to offsets.json across instances', () => {
    store.set('/a/b.jsonl', { offset: 1234, mtime: 99, size: 2000 });
    expect(existsSync(join(home, 'offsets.json'))).toBe(true);

    const reopened = new OffsetStore(home);
    expect(reopened.get('/a/b.jsonl')).toEqual({ offset: 1234, mtime: 99, size: 2000 });
    expect(reopened.all()).toEqual({ '/a/b.jsonl': { offset: 1234, mtime: 99, size: 2000 } });
  });

  it('set overwrites and reset removes', () => {
    store.set('/a', { offset: 1, mtime: 1, size: 1 });
    store.set('/a', { offset: 2, mtime: 2, size: 2 });
    store.set('/b', { offset: 3, mtime: 3, size: 3 });
    expect(store.get('/a')!.offset).toBe(2);

    store.reset('/a');
    expect(store.get('/a')).toBeUndefined();
    expect(store.get('/b')).toBeDefined();

    store.reset();
    expect(store.all()).toEqual({});
  });

  it('survives a corrupt offsets.json by starting over', () => {
    writeFileSync(join(home, 'offsets.json'), 'not json {{{', 'utf8');
    const fresh = new OffsetStore(home);
    expect(fresh.all()).toEqual({});
    fresh.set('/x', { offset: 1, mtime: 1, size: 1 });
    expect(fresh.get('/x')).toEqual({ offset: 1, mtime: 1, size: 1 });
  });
});
