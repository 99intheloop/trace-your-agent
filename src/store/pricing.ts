import type { TokenUsage } from '../core/types.js';

/**
 * Built-in model price table, USD per 1M tokens.
 *
 * WARNING: prices go stale. This table is a best-effort snapshot (mid-2025)
 * of mainstream Anthropic / OpenAI / Moonshot models; always check the
 * official pricing pages for current numbers. Cost figures derived from this
 * table are estimates shown for orientation only.
 */
export interface ModelPricing {
  /** USD per 1M non-cached input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** USD per 1M cache-read tokens (defaults to input rate when absent). */
  cacheReadPer1M?: number;
  /** USD per 1M cache-write tokens (defaults to input rate when absent). */
  cacheWritePer1M?: number;
}

/**
 * Prefix-matched entries: a model id matches the longest table entry that is a
 * prefix of it (e.g. `claude-sonnet-4-5-20250929` matches `claude-sonnet-4-5`).
 * Keys are lowercase.
 */
export const PRICING_TABLE: ReadonlyArray<readonly [prefix: string, pricing: ModelPricing]> = [
  // Anthropic
  // claude-sonnet-5: no official price observed yet — sonnet-4 tier estimate.
  ['claude-sonnet-5', { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }],
  ['claude-opus-4', { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 }],
  ['claude-sonnet-4', { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }],
  ['claude-haiku-4', { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 }],
  ['claude-3-7-sonnet', { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }],
  ['claude-3-5-sonnet', { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }],
  ['claude-3-5-haiku', { inputPer1M: 0.8, outputPer1M: 4, cacheReadPer1M: 0.08, cacheWritePer1M: 1 }],
  ['claude-3-opus', { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 }],
  ['claude-3-haiku', { inputPer1M: 0.25, outputPer1M: 1.25, cacheReadPer1M: 0.03, cacheWritePer1M: 0.3 }],
  // OpenAI
  ['gpt-5-nano', { inputPer1M: 0.05, outputPer1M: 0.4, cacheReadPer1M: 0.005 }],
  ['gpt-5-mini', { inputPer1M: 0.25, outputPer1M: 2, cacheReadPer1M: 0.025 }],
  ['gpt-5', { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.125 }],
  ['gpt-4.1-nano', { inputPer1M: 0.1, outputPer1M: 0.4, cacheReadPer1M: 0.025 }],
  ['gpt-4.1-mini', { inputPer1M: 0.4, outputPer1M: 1.6, cacheReadPer1M: 0.1 }],
  ['gpt-4.1', { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5 }],
  ['gpt-4o-mini', { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.075 }],
  ['gpt-4o', { inputPer1M: 2.5, outputPer1M: 10, cacheReadPer1M: 1.25 }],
  ['o4-mini', { inputPer1M: 1.1, outputPer1M: 4.4, cacheReadPer1M: 0.275 }],
  ['o3', { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5 }],
  ['o1', { inputPer1M: 15, outputPer1M: 60, cacheReadPer1M: 7.5 }],
  // Moonshot / Kimi
  // k3: internal/newer model alias seen in the wild — kimi-k2 tier estimate.
  ['k3', { inputPer1M: 0.6, outputPer1M: 2.5, cacheReadPer1M: 0.15 }],
  ['kimi-k2', { inputPer1M: 0.6, outputPer1M: 2.5, cacheReadPer1M: 0.15 }],
  // moonshot-v1 list prices are in CNY (¥12/¥24/¥60 per 1M for 8k/32k/128k,
  // same rate in/out); converted at ≈7.1 CNY/USD.
  ['moonshot-v1-128k', { inputPer1M: 8.45, outputPer1M: 8.45 }],
  ['moonshot-v1-32k', { inputPer1M: 3.38, outputPer1M: 3.38 }],
  ['moonshot-v1-8k', { inputPer1M: 1.69, outputPer1M: 1.69 }],
] as const;

/** Longest-prefix, case-insensitive lookup; `undefined` when the model is unknown. */
export function lookupPricing(model: string): ModelPricing | undefined {
  const needle = model.toLowerCase();
  let best: ModelPricing | undefined;
  let bestLen = -1;
  for (const [prefix, pricing] of PRICING_TABLE) {
    if (needle.startsWith(prefix) && prefix.length > bestLen) {
      best = pricing;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * Estimate cost in USD for one call. `usage.inputTokens` is treated as
 * non-cached input; cache tokens are priced at their own rates (falling back
 * to the input rate). Returns `undefined` when the model is not in the table.
 */
export function estimateCostUsd(usage: TokenUsage, model: string): number | undefined {
  const pricing = lookupPricing(model);
  if (!pricing) return undefined;
  const inputRate = pricing.inputPer1M / 1_000_000;
  const outputRate = pricing.outputPer1M / 1_000_000;
  const cacheReadRate = (pricing.cacheReadPer1M ?? pricing.inputPer1M) / 1_000_000;
  const cacheWriteRate = (pricing.cacheWritePer1M ?? pricing.inputPer1M) / 1_000_000;
  return (
    usage.inputTokens * inputRate +
    usage.outputTokens * outputRate +
    (usage.cacheReadTokens ?? 0) * cacheReadRate +
    (usage.cacheWriteTokens ?? 0) * cacheWriteRate
  );
}
