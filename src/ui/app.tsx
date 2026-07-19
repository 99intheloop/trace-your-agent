import { useEffect } from 'react';
import { navigate, redirectRootOnce, useRoute } from './router.jsx';
import { SessionsPage } from './pages/sessions.jsx';
import { SessionDetailPage } from './pages/session-detail.jsx';

export function App() {
  const route = useRoute();
  useEffect(redirectRootOnce, []);
  if (route.name === 'session') {
    return (
      <SessionDetailPage
        key={route.sessionId}
        sessionId={route.sessionId}
        highlightSpanId={route.highlightSpanId}
      />
    );
  }
  return <SessionsPage />;
}

/** Convenience wrapper for in-app links. */
export function linkTo(e: { preventDefault(): void }, to: string): void {
  e.preventDefault();
  navigate(to);
}
