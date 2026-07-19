import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getAdapters } from '../adapters/registry.js';
import type { Adapter, DetectedHome } from '../core/source.js';
import { ensureTyaHome } from '../core/home.js';
import { err, formatTable, out } from './util.js';

const HELP = `tya doctor — Check environment: detect agent homes, readability, DB health

Usage: tya doctor [-h]
`;

/** How many session files to count per home before reporting an estimate. */
const SESSION_COUNT_CAP = 10_000;

async function estimateSessionFiles(adapter: Adapter, home: DetectedHome): Promise<string> {
  try {
    let count = 0;
    for await (const ref of adapter.discover(home)) {
      void ref;
      count += 1;
      if (count >= SESSION_COUNT_CAP) return `${SESSION_COUNT_CAP}+`;
    }
    return String(count);
  } catch {
    return '?';
  }
}

async function isReadableDir(dir: string): Promise<boolean> {
  try {
    await readdir(dir);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctorCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { help: { type: 'boolean', short: 'h', default: false } },
    allowPositionals: false,
    strict: false,
  });
  if (values.help === true) {
    out(HELP);
    return 0;
  }

  const adapters = getAdapters();
  if (adapters.length === 0) {
    out('tya doctor — environment check');
    out('');
    out(
      formatTable(
        ['SOURCE', 'STATUS'],
        [
          ['claude-code', 'adapter not registered yet'],
          ['codex', 'adapter not registered yet'],
          ['kimi-code', 'adapter not registered yet'],
        ],
      ),
    );
    out('');
    out('No adapters registered yet — adapter implementations land in a later milestone.');
    return 0;
  }

  const rows: string[][] = [];
  let anyUsable = false;
  for (const adapter of adapters) {
    let home: DetectedHome | null = null;
    let detectError: string | null = null;
    try {
      home = await adapter.detect();
    } catch (e) {
      detectError = e instanceof Error ? e.message : String(e);
    }
    if (home === null) {
      rows.push([adapter.source, '-', 'no', '-', '-', '-', detectError ?? 'not found']);
      continue;
    }
    const exists = existsSync(home.homeDir);
    const readable = exists && home.readable && (await isReadableDir(home.homeDir));
    const sessions = readable ? await estimateSessionFiles(adapter, home) : '-';
    if (exists && readable) anyUsable = true;
    rows.push([
      adapter.source,
      home.homeDir,
      exists ? 'yes' : 'no',
      readable ? 'yes' : 'no',
      home.version ?? '-',
      sessions,
      '',
    ]);
  }

  out('tya doctor — environment check');
  out('');
  out(formatTable(['SOURCE', 'HOME', 'EXISTS', 'READABLE', 'VERSION', 'SESSIONS', 'NOTE'], rows));
  out('');
  try {
    const home = ensureTyaHome();
    out(`tya home: ${home.homeDir}`);
  } catch (e) {
    err(`tya home: unavailable (${e instanceof Error ? e.message : String(e)})`);
    return 1;
  }
  return anyUsable ? 0 : 1;
}
