import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installClaudeCodeHooks,
  isHookInstalled,
  lineDiff,
  uninstallClaudeCodeHooks,
} from './hooks.js';

let claudeHome: string;
let settingsPath: string;
const COMMAND = 'node /pkg/trace-your-agent/dist/hooks/subagent-stop.js';

beforeEach(() => {
  claudeHome = mkdtempSync(join(tmpdir(), 'tya-hooks-'));
  settingsPath = join(claudeHome, 'settings.json');
});

afterEach(() => {
  rmSync(claudeHome, { recursive: true, force: true });
});

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
}

describe('installClaudeCodeHooks', () => {
  it('creates settings.json with the SubagentStop hook when none exists', () => {
    const result = installClaudeCodeHooks({ claudeHome, command: COMMAND });
    expect(result.status).toBe('installed');
    expect(result.backupPath).toBeUndefined(); // nothing to back up
    expect(result.diff).toContain('+');

    const settings = readSettings();
    expect(isHookInstalled(settings)).toBe(true);
    const groups = (settings['hooks'] as Record<string, unknown[]>)['SubagentStop'];
    expect(groups).toHaveLength(1);
    expect(groups?.[0]).toMatchObject({
      hooks: [{ type: 'command', command: COMMAND }],
    });
  });

  it('preserves existing settings and backs the original up', () => {
    const original = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf8');

    const result = installClaudeCodeHooks({ claudeHome, command: COMMAND });
    expect(result.status).toBe('installed');

    const backup = JSON.parse(readFileSync(`${settingsPath}.tya-bak`, 'utf8'));
    expect(backup).toEqual(original);

    const settings = readSettings();
    expect(settings['model']).toBe('opus');
    expect((settings['hooks'] as Record<string, unknown>)['PreToolUse']).toEqual(
      original.hooks.PreToolUse,
    );
    expect(isHookInstalled(settings)).toBe(true);
  });

  it('is idempotent: a second install changes nothing', () => {
    installClaudeCodeHooks({ claudeHome, command: COMMAND });
    const before = readFileSync(settingsPath, 'utf8');
    const result = installClaudeCodeHooks({ claudeHome, command: COMMAND });
    expect(result.status).toBe('already-installed');
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('refuses to clobber an unparseable settings.json', () => {
    writeFileSync(settingsPath, '{not json', 'utf8');
    const result = installClaudeCodeHooks({ claudeHome, command: COMMAND });
    expect(result.status).toBe('error');
    expect(readFileSync(settingsPath, 'utf8')).toBe('{not json');
  });
});

describe('uninstallClaudeCodeHooks', () => {
  it('removes exactly the injected hook and leaves no residue', () => {
    const original = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf8');
    installClaudeCodeHooks({ claudeHome, command: COMMAND });

    const result = uninstallClaudeCodeHooks({ claudeHome });
    expect(result.status).toBe('uninstalled');
    expect(readSettings()).toEqual(original);
    // The install-time backup is preserved, not overwritten.
    expect(existsSync(`${settingsPath}.tya-bak`)).toBe(true);
  });

  it('drops the hooks key entirely when our hook was the only content', () => {
    installClaudeCodeHooks({ claudeHome, command: COMMAND });
    uninstallClaudeCodeHooks({ claudeHome });
    expect(readSettings()).toEqual({});
  });

  it('keeps other SubagentStop entries untouched', () => {
    const original = {
      hooks: {
        SubagentStop: [{ matcher: '', hooks: [{ type: 'command', command: 'other-tool --flag' }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(original), 'utf8');
    installClaudeCodeHooks({ claudeHome, command: COMMAND });
    uninstallClaudeCodeHooks({ claudeHome });
    expect(readSettings()).toEqual(original);
  });

  it('is a no-op when the hook is not installed', () => {
    writeFileSync(settingsPath, '{"model":"opus"}', 'utf8');
    const result = uninstallClaudeCodeHooks({ claudeHome });
    expect(result.status).toBe('not-installed');
    expect(readFileSync(settingsPath, 'utf8')).toBe('{"model":"opus"}');
  });
});

describe('lineDiff', () => {
  it('marks added and removed lines', () => {
    const diff = lineDiff('a\nb\nc\n', 'a\nx\nc\n');
    expect(diff).toContain('- b');
    expect(diff).toContain('+ x');
    expect(diff).toContain('  a');
  });
});
