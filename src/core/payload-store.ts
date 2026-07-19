import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactValue, type RedactOptions } from './redact.js';

/**
 * Content-addressed payload store.
 *
 * Large span inputs/outputs are not inlined into the span tree; they are
 * serialized once under `<home>/payloads/<sha256>.json` and referenced from
 * spans via `payloadRef` (`payloads/<sha256>.json`). Identical content is
 * stored exactly once.
 *
 * Everything written passes through {@link redactValue} (enabled by default).
 */
export class PayloadStore {
  private readonly payloadsDir: string;

  /**
   * @param homeDir tya data root (see home.ts). Payloads live in `<homeDir>/payloads`;
   *                the directory is created if missing.
   */
  constructor(homeDir: string) {
    this.payloadsDir = join(homeDir, 'payloads');
    mkdirSync(this.payloadsDir, { recursive: true });
  }

  /**
   * Serialize `obj` (after redaction) and write it if not already present.
   * @returns the reference to store on the span: `payloads/<sha256>.json`.
   */
  put(obj: unknown, options: RedactOptions = {}): string {
    const redacted = redactValue(obj, options);
    const body = JSON.stringify(redacted, null, 2);
    const hash = createHash('sha256').update(body, 'utf8').digest('hex');
    const ref = `payloads/${hash}.json`;
    const filePath = join(this.payloadsDir, `${hash}.json`);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, body, 'utf8');
    }
    return ref;
  }

  /** Read back a previously stored payload. Throws if the ref is invalid or missing. */
  get(ref: string): unknown {
    this.assertValidRef(ref);
    const filePath = join(this.payloadsDir, ref.slice('payloads/'.length));
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  }

  has(ref: string): boolean {
    this.assertValidRef(ref);
    return existsSync(join(this.payloadsDir, ref.slice('payloads/'.length)));
  }

  /** Refs must be exactly `payloads/<64 hex>.json` — no path traversal. */
  private assertValidRef(ref: string): void {
    if (!/^payloads\/[0-9a-f]{64}\.json$/.test(ref)) {
      throw new Error(`invalid payload ref: ${ref}`);
    }
  }
}
