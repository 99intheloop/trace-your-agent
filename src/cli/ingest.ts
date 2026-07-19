import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getAdapters } from '../adapters/registry.js';
import { IngestPipeline, type IngestReport } from '../core/ingest.js';
import { OffsetStore } from '../core/offsets.js';
import { PayloadStore } from '../core/payload-store.js';
import type { DetectedHome } from '../core/source.js';
import { err, formatTable, openStore, out, parseSource } from './util.js';

const HELP = `tya ingest — Parse agent session logs into the local span store

Usage: tya ingest [options]

Options:
  --source <cc|codex|kimi>  Only ingest one agent source
  --home <dir>              Override the detected agent home directory
  --follow                  (reserved) Follow mode is not in v1
  -h, --help                Show this help
`;

export async function runIngestCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: 'string' },
      home: { type: 'string' },
      follow: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: false,
  });
  if (values.help === true) {
    out(HELP);
    return 0;
  }
  if (values.follow === true) {
    err('tya ingest: follow mode is not in v1');
    return 1;
  }

  let adapters = getAdapters();
  if (typeof values.source === 'string') {
    const source = parseSource(values.source);
    if (source === undefined) {
      err(`tya ingest: unknown source '${values.source}' (expected cc|codex|kimi)`);
      return 1;
    }
    adapters = adapters.filter((a) => a.source === source);
  }

  if (adapters.length === 0) {
    out('No adapters registered yet — nothing to ingest.');
    return 0;
  }

  const { store, home: tyaHome, close } = openStore();
  try {
    const pipeline = new IngestPipeline({
      store,
      offsets: new OffsetStore(tyaHome.homeDir),
      payloads: new PayloadStore(tyaHome.homeDir),
    });
    const totals: IngestReport = {
      filesProcessed: 0,
      spansWritten: 0,
      linksWritten: 0,
      warnings: 0,
      errors: 0,
    };
    const rows: string[][] = [];
    for (const adapter of adapters) {
      let home: DetectedHome | null;
      if (typeof values.home === 'string') {
        home = { source: adapter.source, homeDir: resolve(values.home), readable: true };
      } else {
        home = await adapter.detect();
      }
      if (home === null) {
        rows.push([adapter.source, 'not found', '-', '-', '-', '-', '-']);
        continue;
      }
      const report = await pipeline.ingestAdapter(adapter, home);
      totals.filesProcessed += report.filesProcessed;
      totals.spansWritten += report.spansWritten;
      totals.linksWritten += report.linksWritten;
      totals.warnings += report.warnings;
      totals.errors += report.errors;
      rows.push([
        adapter.source,
        home.homeDir,
        String(report.filesProcessed),
        String(report.spansWritten),
        String(report.linksWritten),
        String(report.warnings),
        String(report.errors),
      ]);
    }
    out(formatTable(['SOURCE', 'HOME', 'FILES', 'SPANS', 'LINKS', 'WARNINGS', 'ERRORS'], rows));
    out('');
    out(
      `ingest complete: ${totals.filesProcessed} file(s), ${totals.spansWritten} span(s), ` +
        `${totals.linksWritten} link(s), ${totals.warnings} warning(s), ${totals.errors} error(s)`,
    );
    return totals.errors > 0 ? 1 : 0;
  } finally {
    close();
  }
}
