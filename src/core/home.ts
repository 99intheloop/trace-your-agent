import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Resolution of trace-your-agent's own data root (NOT the agent homes — those
 * are only ever read, never written).
 *
 * Default: `~/.trace-your-agent/`. Override with the `TYA_HOME` env var.
 */
export const TYA_HOME_ENV = 'TYA_HOME';
export const DEFAULT_HOME_DIRNAME = '.trace-your-agent';

export interface TyaHome {
  /** Absolute path of the data root, e.g. `~/.trace-your-agent`. */
  homeDir: string;
  /** Content-addressed payload store directory: `<home>/payloads`. */
  payloadsDir: string;
  /** Incremental ingest cursor file: `<home>/offsets.json`. */
  offsetsPath: string;
  /** SQLite database file: `<home>/trace.db`. */
  dbPath: string;
}

export function resolveTyaHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TYA_HOME_ENV];
  if (override && override.trim() !== '') return resolve(override);
  return join(homedir(), DEFAULT_HOME_DIRNAME);
}

/** Resolve the data root and ensure it plus `payloads/` exist. */
export function ensureTyaHome(env: NodeJS.ProcessEnv = process.env): TyaHome {
  const homeDir = resolveTyaHome(env);
  const payloadsDir = join(homeDir, 'payloads');
  mkdirSync(payloadsDir, { recursive: true });
  return {
    homeDir,
    payloadsDir,
    offsetsPath: join(homeDir, 'offsets.json'),
    dbPath: join(homeDir, 'trace.db'),
  };
}
