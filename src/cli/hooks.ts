import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { err, out } from './util.js';

/**
 * install-hooks / uninstall-hooks for Claude Code.
 *
 * Injects one command hook into `~/.claude/settings.json`:
 *
 * ```json
 * "hooks": {
 *   "SubagentStop": [
 *     { "matcher": "", "hooks": [ { "type": "command", "command": "node <pkg>/dist/hooks/subagent-stop.js" } ] }
 *   ]
 * }
 * ```
 *
 * The hook script appends one JSON line per subagent stop to
 * `<TYA_HOME>/joins.jsonl`, which later milestones use to join subagent
 * transcripts to the spawning Task tool call. Claude Code's settings file is
 * the ONLY agent file tya ever writes (and only on explicit install).
 */

const HOOK_EVENT = 'SubagentStop';
const BACKUP_SUFFIX = '.tya-bak';

/** Absolute path of the built hook script shipped with this package. */
export function resolveHookScriptPath(): string {
  // In the built bundle this file is dist/cli.js, so this resolves to
  // dist/hooks/subagent-stop.js (see tsup.config.ts entry map).
  return fileURLToPath(new URL('./hooks/subagent-stop.js', import.meta.url));
}

/** The exact command line written into settings.json. */
export function resolveHookCommand(): string {
  return `node ${resolveHookScriptPath()}`;
}

/** True for hook commands that point at this package's subagent-stop script. */
function isOurHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  if (command === resolveHookCommand()) return true;
  return command.includes('trace-your-agent') && command.includes('subagent-stop.js');
}

interface HookEntry {
  type?: string;
  command?: string;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

type Settings = Record<string, unknown>;

function readSettings(settingsPath: string): { settings: Settings } | { error: string } {
  if (!existsSync(settingsPath)) return { settings: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: `settings file is not a JSON object: ${settingsPath}` };
    }
    return { settings: parsed as Settings };
  } catch (e) {
    return { error: `cannot parse ${settingsPath}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function hookGroups(settings: Settings): HookGroup[] {
  const hooks = settings['hooks'];
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const groups = (hooks as Record<string, unknown>)[HOOK_EVENT];
  if (!Array.isArray(groups)) return [];
  return groups as HookGroup[];
}

export function isHookInstalled(settings: Settings): boolean {
  return hookGroups(settings).some((group) =>
    (group.hooks ?? []).some((hook) => hook.type === 'command' && isOurHookCommand(hook.command)),
  );
}

/** Minimal line diff (`-`/`+` prefixes, context lines unprefixed). */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  // LCS over lines — settings files are small, O(n*m) is fine.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push(`- ${a[i]}`);
      i += 1;
    } else {
      lines.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length) lines.push(`- ${a[i++]}`);
  while (j < b.length) lines.push(`+ ${b[j++]}`);
  return lines.join('\n');
}

function serialize(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export interface HooksResult {
  status: 'installed' | 'already-installed' | 'uninstalled' | 'not-installed' | 'error';
  settingsPath: string;
  backupPath?: string;
  diff?: string;
  message?: string;
}

export interface HooksOptions {
  /** Claude Code home; defaults to `~/.claude`. */
  claudeHome?: string;
  /** Hook command to install; defaults to this package's built script. */
  command?: string;
}

export function installClaudeCodeHooks(options: HooksOptions = {}): HooksResult {
  const claudeHome = options.claudeHome ?? join(homedir(), '.claude');
  const settingsPath = join(claudeHome, 'settings.json');
  const backupPath = `${settingsPath}${BACKUP_SUFFIX}`;
  const command = options.command ?? resolveHookCommand();

  const read = readSettings(settingsPath);
  if ('error' in read) {
    return { status: 'error', settingsPath, message: read.error };
  }
  const settings = read.settings;
  if (isHookInstalled(settings)) {
    return { status: 'already-installed', settingsPath, backupPath };
  }

  const next: Settings = JSON.parse(JSON.stringify(settings)) as Settings;
  const hooks = (next['hooks'] ?? {}) as Record<string, unknown>;
  next['hooks'] = hooks;
  const groups = (hooks[HOOK_EVENT] ?? []) as HookGroup[];
  hooks[HOOK_EVENT] = groups;
  groups.push({ matcher: '', hooks: [{ type: 'command', command }] });

  const before = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '';
  const after = serialize(next);
  const diff = lineDiff(before, after);

  mkdirSync(claudeHome, { recursive: true });
  if (existsSync(settingsPath)) copyFileSync(settingsPath, backupPath);
  writeFileSync(settingsPath, after, 'utf8');
  return {
    status: 'installed',
    settingsPath,
    ...(existsSync(backupPath) ? { backupPath } : {}),
    diff,
  };
}

export function uninstallClaudeCodeHooks(options: HooksOptions = {}): HooksResult {
  const claudeHome = options.claudeHome ?? join(homedir(), '.claude');
  const settingsPath = join(claudeHome, 'settings.json');
  const backupPath = `${settingsPath}${BACKUP_SUFFIX}`;

  const read = readSettings(settingsPath);
  if ('error' in read) {
    return { status: 'error', settingsPath, message: read.error };
  }
  const settings = read.settings;
  if (!isHookInstalled(settings)) {
    return { status: 'not-installed', settingsPath, backupPath };
  }

  const next: Settings = JSON.parse(JSON.stringify(settings)) as Settings;
  const hooks = next['hooks'] as Record<string, unknown>;
  const kept: HookGroup[] = [];
  for (const group of hookGroups(next)) {
    const original = group.hooks ?? [];
    if (original.length === 0) {
      kept.push(group);
      continue;
    }
    const keptHooks = original.filter(
      (hook) => !(hook.type === 'command' && isOurHookCommand(hook.command)),
    );
    if (keptHooks.length > 0) kept.push({ ...group, hooks: keptHooks });
    // Groups that contained only our hook are dropped entirely.
  }
  if (kept.length === 0) {
    delete hooks[HOOK_EVENT];
    if (Object.keys(hooks).length === 0) delete next['hooks'];
  } else {
    hooks[HOOK_EVENT] = kept;
  }
  // No re-backup here: the .tya-bak taken at install time keeps the pristine
  // original, and uninstall must not overwrite it.
  writeFileSync(settingsPath, serialize(next), 'utf8');
  return { status: 'uninstalled', settingsPath, backupPath };
}

const HELP = `tya install-hooks / uninstall-hooks — Manage the Claude Code SubagentStop hook

Usage:
  tya install-hooks claude-code     Inject the hook into ~/.claude/settings.json
  tya uninstall-hooks claude-code   Remove exactly the hook tya injected

install prints the settings diff and backs the original up to
settings.json.tya-bak before writing. uninstall never deletes the backup.
`;

export async function runHooksCommand(args: string[], install: boolean): Promise<number> {
  const verb = install ? 'install-hooks' : 'uninstall-hooks';
  const { values, positionals } = parseArgs({
    args,
    options: { help: { type: 'boolean', short: 'h', default: false } },
    allowPositionals: true,
    strict: false,
  });
  if (values.help === true) {
    out(HELP);
    return 0;
  }
  const target = positionals[0];
  if (target !== 'claude-code') {
    err(`tya ${verb}: expected target 'claude-code' (other agents are not supported yet)`);
    return 1;
  }

  const result = install ? installClaudeCodeHooks() : uninstallClaudeCodeHooks();
  switch (result.status) {
    case 'installed':
      out(`settings: ${result.settingsPath}`);
      if (result.backupPath !== undefined) out(`backup:   ${result.backupPath}`);
      out('');
      out('diff:');
      out(result.diff ?? '(no changes)');
      out('');
      out(`installed ${HOOK_EVENT} hook. It appends subagent joins to <TYA_HOME>/joins.jsonl.`);
      return 0;
    case 'already-installed':
      out(`hook already installed in ${result.settingsPath} — nothing to do.`);
      return 0;
    case 'uninstalled':
      out(`removed the tya ${HOOK_EVENT} hook from ${result.settingsPath}.`);
      out(`backup kept at ${result.backupPath ?? '(none)'} (delete it manually if unwanted).`);
      return 0;
    case 'not-installed':
      out(`no tya hook found in ${result.settingsPath} — nothing to do.`);
      return 0;
    case 'error':
      err(`tya ${verb}: ${result.message ?? 'unknown error'}`);
      return 1;
  }
}
