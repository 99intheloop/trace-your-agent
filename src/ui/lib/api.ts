/**
 * Browser-side data layer for the tya REST API (docs/api.md).
 * Base URL is same-origin; vite dev proxies /api → http://127.0.0.1:4777.
 */
import type {
  CwdsResponse,
  SearchResponse,
  SessionSummary,
  SessionsResponse,
  SourcesResponse,
  SpansResponse,
  SuccessStat,
} from './types.js';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body: unknown = await res.json();
      if (
        body !== null &&
        typeof body === 'object' &&
        typeof (body as { error?: unknown }).error === 'string'
      ) {
        message = (body as { error: string }).error;
      }
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s === '' ? '' : `?${s}`;
}

export const api = {
  sessions(
    opts: {
      source?: string | undefined;
      limit?: number;
      offset?: number;
      cwd?: string | undefined;
      from?: number | undefined;
      hasError?: boolean | undefined;
      spanQ?: string | undefined;
      build?: 'pass' | 'fail' | 'none' | undefined;
    } = {},
  ) {
    return getJson<SessionsResponse>(
      `/api/sessions${qs({
        source: opts.source,
        limit: opts.limit,
        offset: opts.offset,
        cwd: opts.cwd,
        from: opts.from,
        hasError: opts.hasError === undefined ? undefined : opts.hasError ? '1' : '0',
        spanQ: opts.spanQ,
        build: opts.build,
      })}`,
    );
  },
  session(sessionId: string) {
    return getJson<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  },
  spans(sessionId: string) {
    return getJson<SpansResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/spans`);
  },
  search(q: string, opts: { source?: string | undefined; limit?: number } = {}) {
    return getJson<SearchResponse>(
      `/api/search${qs({ q, source: opts.source, limit: opts.limit })}`,
    );
  },
  payload(ref: string) {
    return getJson<unknown>(`/api/payloads/${encodeURIComponent(ref)}`);
  },
  sources() {
    return getJson<SourcesResponse>('/api/sources');
  },
  cwds(source?: string | undefined) {
    return getJson<CwdsResponse>(`/api/cwds${qs({ source })}`);
  },
  async setVerdict(
    sessionId: string,
    patch: {
      verdict?: 'pass' | 'partial' | 'fail' | null;
      taskType?: 'feature' | 'fix' | 'change' | 'ask' | null;
      note?: string | null;
    },
  ): Promise<SessionSummary> {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/verdict`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const msg =
        body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return (await res.json()) as SessionSummary;
  },
  successStats(groupBy: 'source' | 'cwd' | 'taskType' | 'week') {
    return getJson<{ stats: SuccessStat[] }>(`/api/stats/success${qs({ groupBy })}`);
  },
};
