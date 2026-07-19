import { describe, expect, it } from 'vitest';
import { estimateCostUsd, lookupPricing, PRICING_TABLE } from './pricing.js';

describe('pricing', () => {
  it('matches by longest prefix, case-insensitive', () => {
    expect(lookupPricing('claude-sonnet-4-5-20250929')?.inputPer1M).toBe(3);
    expect(lookupPricing('Claude-Opus-4-1')?.outputPer1M).toBe(75);
    // gpt-4.1-mini must beat gpt-4.1
    expect(lookupPricing('gpt-4.1-mini-2025-04-14')?.inputPer1M).toBe(0.4);
    expect(lookupPricing('gpt-4.1-2025-04-14')?.inputPer1M).toBe(2);
  });

  it('returns undefined for unknown models', () => {
    expect(lookupPricing('some-local-model')).toBeUndefined();
  });

  it('estimates cost incl. cache rates', () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000 },
      'claude-sonnet-4-5',
    );
    // 3 * 1 + 15 * 0.1 + 0.3 * 2 = 3 + 1.5 + 0.6
    expect(cost).toBeCloseTo(5.1, 10);
  });

  it('falls back to input rate when no cache rate is listed', () => {
    const cost = estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, 'o1');
    expect(cost).toBeCloseTo(7.5, 10);
  });

  it('undefined cost for unknown model', () => {
    expect(estimateCostUsd({ inputTokens: 1, outputTokens: 1 }, 'nope')).toBeUndefined();
  });

  it('covers claude / gpt / kimi families', () => {
    const prefixes = PRICING_TABLE.map(([p]) => p);
    expect(prefixes.some((p) => p.startsWith('claude'))).toBe(true);
    expect(prefixes.some((p) => p.startsWith('gpt'))).toBe(true);
    expect(prefixes.some((p) => p.startsWith('kimi'))).toBe(true);
  });
});
