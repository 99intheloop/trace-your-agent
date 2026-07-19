import type { Adapter } from '../core/source.js';
import { ClaudeCodeAdapter } from './claude-code/index.js';
import { CodexAdapter } from './codex/index.js';
import { KimiCodeAdapter } from './kimi-code/index.js';

/**
 * Adapter registry — one instance per supported agent CLI.
 * Adapters are constructed lazily per call so per-command env (e.g.
 * KIMI_CODE_HOME in tests) is honored.
 */
export function getAdapters(): Adapter[] {
  return [new ClaudeCodeAdapter(), new CodexAdapter(), new KimiCodeAdapter()];
}
