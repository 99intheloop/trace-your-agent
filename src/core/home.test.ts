import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureTyaHome, resolveTyaHome, TYA_HOME_ENV } from './home.js';

describe('home', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('defaults to ~/.trace-your-agent', () => {
    expect(resolveTyaHome({})).toBe(join(homedir(), '.trace-your-agent'));
  });

  it('honors TYA_HOME override', () => {
    const base = mkdtempSync(join(tmpdir(), 'tya-home-'));
    dirs.push(base);
    const custom = join(base, 'nested', 'tya');
    expect(resolveTyaHome({ [TYA_HOME_ENV]: custom })).toBe(custom);
  });

  it('ensureTyaHome creates root and payloads/, returns standard paths', () => {
    const base = mkdtempSync(join(tmpdir(), 'tya-home-'));
    dirs.push(base);
    const home = ensureTyaHome({ [TYA_HOME_ENV]: join(base, 'data') });
    expect(existsSync(home.homeDir)).toBe(true);
    expect(existsSync(home.payloadsDir)).toBe(true);
    expect(home.offsetsPath).toBe(join(home.homeDir, 'offsets.json'));
    expect(home.dbPath).toBe(join(home.homeDir, 'trace.db'));
    // idempotent
    expect(() => ensureTyaHome({ [TYA_HOME_ENV]: join(base, 'data') })).not.toThrow();
  });
});
