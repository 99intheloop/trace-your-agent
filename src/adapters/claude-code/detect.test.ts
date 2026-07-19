import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DetectedHome, SessionRef } from '../../core/source.js';
import { ClaudeCodeAdapter } from './adapter.js';
import {
  JOIN_SESSION,
  materializeHome,
  ORPHAN_SESSION,
  SUB_AGENT_ID,
  SUB_SESSION,
  type FakeHome,
} from './fixtures.js';

let root: string;
let home: FakeHome;
let adapter: ClaudeCodeAdapter;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tya-cc-detect-'));
  home = materializeHome(root);
  adapter = new ClaudeCodeAdapter({ claudeHome: home.claudeHome, tyaHome: home.tyaHome });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ClaudeCodeAdapter.detect', () => {
  it('returns null when the agent home does not exist', async () => {
    const missing = new ClaudeCodeAdapter({ claudeHome: join(root, 'nope') });
    expect(await missing.detect()).toBeNull();
  });

  it('reports home, readability, session count and latest version', async () => {
    const detected = await adapter.detect();
    expect(detected).not.toBeNull();
    expect(detected!.source).toBe('claude-code');
    expect(detected!.homeDir).toBe(home.claudeHome);
    expect(detected!.readable).toBe(true);
    expect(detected!.sessionCount).toBe(6);
    expect(detected!.version).toBe('2.1.0');
  });
});

describe('ClaudeCodeAdapter.discover', () => {
  let sessions: SessionRef[];

  beforeAll(async () => {
    const detected = (await adapter.detect()) as DetectedHome;
    sessions = [];
    for await (const ref of adapter.discover(detected)) sessions.push(ref);
  });

  it('enumerates main session files only (sidechains never become sessions)', () => {
    const ids = sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(['sess-int', JOIN_SESSION, ORPHAN_SESSION, 'sess-simple', SUB_SESSION, 'sess-tools'].sort());
    expect(sessions.every((s) => !s.filePath.includes('agent-'))).toBe(true);
  });

  it('attaches nested subagents/ sidechains with agentId and metaPath', () => {
    const sub = sessions.find((s) => s.sessionId === SUB_SESSION);
    expect(sub?.sidechains).toHaveLength(1);
    const sc = sub!.sidechains![0]!;
    expect(sc.agentId).toBe(SUB_AGENT_ID);
    expect(sc.filePath.endsWith(`agent-${SUB_AGENT_ID}.jsonl`)).toBe(true);
    expect(sc.metaPath?.endsWith(`agent-${SUB_AGENT_ID}.meta.json`)).toBe(true);
  });

  it('attaches sidechains without meta files too', () => {
    const j = sessions.find((s) => s.sessionId === JOIN_SESSION);
    expect(j?.sidechains).toHaveLength(1);
    expect(j!.sidechains![0]!.metaPath).toBeUndefined();
    const o = sessions.find((s) => s.sessionId === ORPHAN_SESSION);
    expect(o?.sidechains).toHaveLength(1);
  });

  it('attributes same-dir agent-*.jsonl via first-line sessionId (older layout)', async () => {
    // Move the sidechain next to the main file and rediscover.
    const fs = await import('node:fs');
    const projDir = join(home.claudeHome, 'projects', '-Users-test-proj');
    const nested = join(projDir, SUB_SESSION, 'subagents', `agent-${SUB_AGENT_ID}.jsonl`);
    const sameDir = join(projDir, `agent-${SUB_AGENT_ID}.jsonl`);
    fs.copyFileSync(nested, sameDir);
    fs.rmSync(join(projDir, SUB_SESSION), { recursive: true, force: true });
    try {
      const detected = (await adapter.detect()) as DetectedHome;
      const found: SessionRef[] = [];
      for await (const ref of adapter.discover(detected)) found.push(ref);
      // agent-*.jsonl must not appear as its own session…
      expect(found.some((s) => s.sessionId.startsWith('agent-'))).toBe(false);
      // …and must be re-attached to its owner.
      const sub = found.find((s) => s.sessionId === SUB_SESSION);
      expect(sub?.sidechains?.map((x) => x.agentId)).toEqual([SUB_AGENT_ID]);
    } finally {
      fs.mkdirSync(join(projDir, SUB_SESSION, 'subagents'), { recursive: true });
      fs.copyFileSync(sameDir, nested);
      fs.rmSync(sameDir, { force: true });
    }
  });
});
