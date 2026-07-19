/**
 * Minimal hand-rolled router: history API + popstate, no react-router.
 * Routes (docs/api.md): `/` → redirect `/sessions`; `/sessions`;
 * `/sessions/:sessionId` (+ optional `?span=<spanId>` highlight).
 */
import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'sessions' }
  | { name: 'session'; sessionId: string; highlightSpanId: string | null };

export function navigate(to: string, replace = false): void {
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  return () => window.removeEventListener('popstate', cb);
}

function currentPath(): string {
  return window.location.pathname + window.location.search;
}

/** Reactive route derived from the current URL. */
export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, currentPath);
  const [pathname = '/', search = ''] = path.split('?');
  const seg = pathname.split('/').filter(Boolean);
  const sessionId = seg[0] === 'sessions' ? seg[1] : undefined;
  if (sessionId) {
    return {
      name: 'session',
      sessionId: decodeURIComponent(sessionId),
      highlightSpanId: new URLSearchParams(search).get('span'),
    };
  }
  return { name: 'sessions' };
}

/** Normalize the URL once on load: `/` (and anything unknown) → `/sessions`. */
export function redirectRootOnce(): void {
  const p = window.location.pathname;
  if (p !== '/sessions' && !p.startsWith('/sessions/')) {
    navigate('/sessions', true);
  }
}
