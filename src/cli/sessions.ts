import { parseArgs } from 'node:util';
import type { Source } from '../core/types.js';
import { err, formatIso, formatTable, openStore, out, parseSource, truncate } from './util.js';

const HELP = `tya sessions — List recorded sessions

Usage: tya sessions [options]

Options:
  --source <cc|codex|kimi>  Only list one agent source
  --limit <N>               Max sessions to print (default: 20)
  -h, --help                Show this help
`;

export async function runSessionsCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: false,
  });
  if (values.help === true) {
    out(HELP);
    return 0;
  }

  let sourceFilter: Source | undefined;
  if (typeof values.source === 'string') {
    const source = parseSource(values.source);
    if (source === undefined) {
      err(`tya sessions: unknown source '${values.source}' (expected cc|codex|kimi)`);
      return 1;
    }
    sourceFilter = source;
  }
  const limit = typeof values.limit === 'string' ? Number(values.limit) : 20;
  if (!Number.isInteger(limit) || limit <= 0) {
    err(`tya sessions: --limit must be a positive integer`);
    return 1;
  }

  const { store, close } = openStore();
  try {
    const rows = store.listSessions({
      ...(sourceFilter !== undefined ? { source: sourceFilter } : {}),
      limit,
    });
    if (rows.length === 0) {
      out('No sessions recorded yet. Run `tya ingest` first.');
      return 0;
    }
    out(
      formatTable(
        ['SESSION ID', 'SOURCE', 'STARTED', 'CWD', 'SPANS', 'TURNS', 'TOKENS', 'COST', 'ERR'],
        rows.map((row) => [
          row.sessionId,
          row.source,
          formatIso(row.startedAtMs),
          truncate(row.cwd ?? '-', 40),
          String(row.spanCount),
          String(row.turnCount),
          `${row.totalInputTokens}+${row.totalOutputTokens}`,
          `$${row.totalCostUsd.toFixed(4)}`,
          String(row.errorCount),
        ]),
      ),
    );
    return 0;
  } finally {
    close();
  }
}
