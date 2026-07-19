import { ensureTyaHome, type TyaHome } from '../core/home.js';
import type { Source } from '../core/types.js';
import { TraceStore } from '../store/store.js';

/** Shared helpers for CLI subcommands. */

/** `--source` accepts short aliases as well as full source names. */
const SOURCE_ALIASES: Record<string, Source> = {
  cc: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  kimi: 'kimi-code',
  'kimi-code': 'kimi-code',
};

export function parseSource(input: string): Source | undefined {
  return SOURCE_ALIASES[input.toLowerCase()];
}

export interface OpenedStore {
  store: TraceStore;
  home: TyaHome;
  close: () => void;
}

/** Resolve TYA_HOME, create it, and open the trace database. */
export function openStore(): OpenedStore {
  const home = ensureTyaHome();
  const store = new TraceStore(home.dbPath);
  return { store, home, close: () => store.close() };
}

/** Render a plain fixed-width text table (no colors, no box drawing). */
export function formatTable(headers: readonly string[], rows: readonly string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const renderRow = (cells: readonly string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  const lines = [renderRow(headers), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const row of rows) lines.push(renderRow(row));
  return lines.join('\n');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

export function formatIso(ms: number | null): string {
  if (ms === null) return '-';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

export function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function err(text: string): void {
  process.stderr.write(`${text}\n`);
}
