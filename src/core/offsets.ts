import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Incremental ingest cursors, persisted at `<home>/offsets.json`.
 *
 * For each source file we remember how far we parsed (`offset`, in bytes)
 * plus the `mtime`/`size` seen at that point, so ingest can:
 * - resume where it left off, and
 * - detect truncation/rotation (size shrank or mtime rewound) and re-parse.
 *
 * Writes are atomic: serialize to a temp file in the same directory, then rename.
 */
export interface FileCursor {
  /** Byte offset up to which the file has been parsed. */
  offset: number;
  /** File mtime (ms) observed when the cursor was written. */
  mtime: number;
  /** File size (bytes) observed when the cursor was written. */
  size: number;
}

export type OffsetMap = Record<string, FileCursor>;

export class OffsetStore {
  private readonly filePath: string;
  private cache: OffsetMap | null = null;

  /** @param homeDir tya data root (see home.ts); must already exist. */
  constructor(homeDir: string) {
    this.filePath = join(homeDir, 'offsets.json');
  }

  /** Cursor for a source file path, or `undefined` if never ingested. */
  get(filePath: string): FileCursor | undefined {
    return this.load()[filePath];
  }

  /** Record (and immediately persist) the cursor for a source file path. */
  set(filePath: string, cursor: FileCursor): void {
    const map = this.load();
    map[filePath] = cursor;
    this.save(map);
  }

  /** Drop one file's cursor (or all cursors when called without a path). */
  reset(filePath?: string): void {
    if (filePath === undefined) {
      this.save({});
      return;
    }
    const map = this.load();
    delete map[filePath];
    this.save(map);
  }

  /** Snapshot of all cursors. */
  all(): OffsetMap {
    return { ...this.load() };
  }

  private load(): OffsetMap {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = {};
      return this.cache;
    }
    try {
      this.cache = JSON.parse(readFileSync(this.filePath, 'utf8')) as OffsetMap;
    } catch {
      // A corrupt cursor file must not break ingest; start over.
      this.cache = {};
    }
    return this.cache;
  }

  private save(map: OffsetMap): void {
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(map, null, 2), 'utf8');
    renameSync(tmpPath, this.filePath);
    this.cache = map;
  }
}
