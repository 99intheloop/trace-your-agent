/**
 * SearchBox — debounced full-text search against /api/search (FTS5).
 * Picking a hit navigates to the owning session and highlights the span.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { kindColorHex } from '../lib/colors.js';
import { fmtTime } from '../lib/format.js';
import type { SearchHit } from '../lib/types.js';
import { navigate } from '../router.jsx';

export function SearchBox({ source }: { source: string }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const query = q.trim();
    if (query === '') {
      setResults([]);
      setOpen(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = ++seq.current;
    const timer = setTimeout(() => {
      api
        .search(query, { source: source === 'all' ? undefined : source, limit: 20 })
        .then((d) => {
          if (seq.current !== id) return;
          setResults(d.results);
          setOpen(true);
          setFailed(false);
        })
        .catch(() => {
          if (seq.current !== id) return;
          setResults([]);
          setOpen(true);
          setFailed(true);
        })
        .finally(() => {
          if (seq.current === id) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [q, source]);

  function pick(hit: SearchHit) {
    setOpen(false);
    setQ('');
    navigate(
      `/sessions/${encodeURIComponent(hit.sessionId)}?span=${encodeURIComponent(hit.spanId)}`,
    );
  }

  return (
    <div className="search-wrap" style={{ width: 320 }}>
      <input
        className="input"
        style={{ width: '100%' }}
        type="search"
        placeholder="Search spans (name / input / output)…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => {
          if (results.length > 0 || failed) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open ? (
        <>
          <div className="search-backdrop" onClick={() => setOpen(false)} />
          <div className="search-results">
            {failed ? (
              <div style={{ padding: 12, fontSize: 12, color: 'var(--color-status-error)' }}>
                search failed
              </div>
            ) : results.length === 0 ? (
              <div style={{ padding: 12, fontSize: 12, color: 'var(--color-fg-faint)' }}>
                {searching ? 'searching…' : 'no results'}
              </div>
            ) : (
              results.map((hit) => (
                <SearchHitRow key={hit.spanId} hit={hit} onPick={pick} />
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function SearchHitRow({ hit, onPick }: { hit: SearchHit; onPick: (hit: SearchHit) => void }) {
  const color = kindColorHex(hit.kind);
  return (
    <div className="search-hit" onClick={() => onPick(hit)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span
          style={{
            fontSize: '9px',
            fontWeight: 600,
            padding: '1px 5px',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: `${color}22`,
            color,
            flexShrink: 0,
            textTransform: 'uppercase',
          }}
        >
          {hit.kind.replace('_CALL', '').replace('_TURN', '').slice(0, 6)}
        </span>
        <span
          style={{
            fontSize: '12px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-fg-default)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {hit.name}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            fontSize: '10px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-fg-faint)',
          }}
        >
          {hit.sessionId.slice(0, 8)} · {fmtTime(hit.startTimeMs)}
        </span>
      </div>
      {hit.snippet ? (
        <div
          style={{
            marginTop: 2,
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-fg-faint)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {hit.snippet}
        </div>
      ) : null}
    </div>
  );
}
