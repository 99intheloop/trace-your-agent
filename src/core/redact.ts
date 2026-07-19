/**
 * Redaction applied to any free-form string/object before it is persisted
 * (payload store, span summaries, attributes copied from raw content).
 *
 * Enabled by default everywhere; can be disabled per call site via options.
 * Replacement is always the literal `[REDACTED]`.
 */

export const REDACTED = '[REDACTED]';

export interface RedactOptions {
  /** Default: true. When false, input is returned unchanged. */
  enabled?: boolean;
}

interface Pattern {
  regex: RegExp;
  /** Replacement; may contain group refs like `$1`. */
  replace: string;
}

const PATTERNS: Pattern[] = [
  // Anthropic API keys.
  { regex: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // OpenAI-style keys (sk-..., sk-proj-...). Requires a word boundary so
  // ordinary words like "ask-123" are untouched.
  { regex: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained PATs.
  { regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g, replace: REDACTED },
  { regex: /\bgithub_pat_[A-Za-z0-9_]{10,}/g, replace: REDACTED },
  // AWS access key ids.
  { regex: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  // HTTP Bearer tokens (header values).
  { regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `Bearer ${REDACTED}` },
  // KEY=VALUE / KEY: VALUE forms, incl. JSON-ish `"api_key": "value"`.
  // The value must be at least 4 non-space chars so prose like
  // "the password field" or "token = ?" is not touched.
  {
    regex:
      /\b(api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret(?:[_-]?key)?|private[_-]?key|client[_-]?secret|password|passwd)\b(["']?)(\s*[:=]\s*)(["']?)([^\s"',}\]]{4,})(["']?)/gi,
    replace: `$1$2$3$4${REDACTED}$6`,
  },
];

/** Redact secrets from a single string. */
export function redactString(input: string, options: RedactOptions = {}): string {
  if (options.enabled === false) return input;
  let out = input;
  for (const { regex, replace } of PATTERNS) {
    out = out.replace(regex, replace);
  }
  return out;
}

/**
 * Deep-redact any JSON-shaped value: strings are redacted, arrays and plain
 * objects are recursed (object keys are preserved, values redacted), other
 * primitives pass through. Non-plain objects are returned as-is.
 */
export function redactValue<T>(value: T, options: RedactOptions = {}): T {
  if (options.enabled === false) return value;
  if (typeof value === 'string') return redactString(value, options) as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, options)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, options);
    }
    return out as T;
  }
  return value;
}
