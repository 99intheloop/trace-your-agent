import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { TraceStore } from '../store/store.js';
import { err, openStore, out } from './util.js';

const HELP = `tya prune — Delete local trace data (old payloads)

Usage: tya prune --older <days> [options]

Options:
  --older <days>  Delete payload files whose mtime is older than this many days (required)
  --dry-run       Print what would be deleted without deleting anything
  -h, --help      Show this help

Also nulls the matching payload_ref columns in the database and VACUUMs it
(skipped together with the deletion on --dry-run).
`;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  payloadsDir: string;
  store?: TraceStore;
  olderDays: number;
  dryRun?: boolean;
  /** Defaults to Date.now(); injectable for tests. */
  now?: number;
}

export interface PruneResult {
  scanned: number;
  matched: number;
  freedBytes: number;
  refsCleared: number;
  dryRun: boolean;
  deletedRefs: string[];
}

/**
 * Delete payload files older than `olderDays`, null out their `payload_ref`
 * in the store, and VACUUM. With `dryRun`, nothing is deleted or rewritten.
 */
export function prunePayloads(options: PruneOptions): PruneResult {
  const dryRun = options.dryRun === true;
  const now = options.now ?? Date.now();
  const cutoff = now - options.olderDays * DAY_MS;
  const result: PruneResult = {
    scanned: 0,
    matched: 0,
    freedBytes: 0,
    refsCleared: 0,
    dryRun,
    deletedRefs: [],
  };

  let entries: string[];
  try {
    entries = readdirSync(options.payloadsDir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!/^[0-9a-f]{64}\.json$/.test(entry)) continue;
    const filePath = join(options.payloadsDir, entry);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    result.scanned += 1;
    if (stat.mtimeMs >= cutoff) continue;
    result.matched += 1;
    result.freedBytes += stat.size;
    result.deletedRefs.push(`payloads/${entry}`);
    if (!dryRun) unlinkSync(filePath);
  }

  if (!dryRun && options.store !== undefined) {
    result.refsCleared = options.store.clearPayloadRefs(result.deletedRefs);
    options.store.vacuum();
  }
  return result;
}

export async function runPruneCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      older: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: false,
  });
  if (values.help === true) {
    out(HELP);
    return 0;
  }
  if (values.older === undefined) {
    err('tya prune: --older <days> is required. See `tya prune --help`.');
    return 1;
  }
  const olderDays = Number(values.older);
  if (!Number.isFinite(olderDays) || olderDays < 0) {
    err(`tya prune: --older must be a non-negative number, got '${values.older}'`);
    return 1;
  }
  const dryRun = values['dry-run'] === true;

  const { store, home, close } = openStore();
  try {
    const result = prunePayloads({
      payloadsDir: home.payloadsDir,
      store,
      olderDays,
      dryRun,
    });
    const verb = dryRun ? 'would delete' : 'deleted';
    out(
      `prune ${dryRun ? '(dry-run) ' : ''}: ${verb} ${result.matched} of ${result.scanned} payload file(s) ` +
        `(${result.freedBytes} bytes); ${result.refsCleared} payload_ref(s) cleared` +
        (dryRun ? '; database untouched' : '; database vacuumed'),
    );
    return 0;
  } finally {
    close();
  }
}
