/**
 * SearchBox — debounced full-text search against /api/search (FTS5).
 * 输入中:下拉展示 span 级命中(命中字段徽章 + 关键词高亮 + 项目名),点击跳转。
 * Enter / 搜索按钮:onSearch(q) 交给外层做 session 级表格过滤;Esc 只关下拉。
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtTime } from '../lib/format.js';
import type { SearchHit } from '../lib/types.js';
import { navigate } from '../router.jsx';

const FIELD_BADGE: Record<string, { label: string; color: string }> = {
  input: { label: 'in', color: '#3b82f6' },
  output: { label: 'out', color: '#22c55e' },
  name: { label: 'name', color: '#64748b' },
};

/** 平台徽章配色(与全局平台色一致)。 */
const PLATFORM_COLOR: Record<string, string> = {
  'claude-code': '#f59e0b',
  'kimi-code': '#6366f1',
  codex: '#22c55e',
};

/** cwd 末段(项目名),比 sessionId 前缀可辨识。 */
function cwdTail(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const segs = cwd.split('/').filter((s) => s !== '');
  return segs[segs.length - 1];
}

/** 大小写不敏感的纯文本关键词高亮(不用正则,防特殊字符)。 */
function Highlight({ text, query }: { text: string; query: string }) {
  const tokens = (query.match(/[\p{L}\p{N}_.-]+/gu) ?? []).map((t) => t.toLowerCase());
  if (tokens.length === 0) return <>{text}</>;
  const parts: Array<{ str: string; hit: boolean }> = [];
  let rest = text;
  while (rest.length > 0) {
    let earliest = -1;
    let earliestTok = '';
    const lower = rest.toLowerCase();
    for (const tok of tokens) {
      const at = lower.indexOf(tok);
      if (at !== -1 && (earliest === -1 || at < earliest)) {
        earliest = at;
        earliestTok = tok;
      }
    }
    if (earliest === -1) {
      parts.push({ str: rest, hit: false });
      break;
    }
    if (earliest > 0) parts.push({ str: rest.slice(0, earliest), hit: false });
    parts.push({ str: rest.slice(earliest, earliest + earliestTok.length), hit: true });
    rest = rest.slice(earliest + earliestTok.length);
  }
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} style={{ background: 'rgba(245,158,11,0.3)', color: '#fbbf24', borderRadius: 2, padding: 0 }}>
            {p.str}
          </mark>
        ) : (
          <span key={i}>{p.str}</span>
        ),
      )}
    </>
  );
}

export function SearchBox({
  source,
  onSearch,
}: {
  source: string;
  onSearch?: ((q: string) => void) | undefined;
}) {
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

  function submit() {
    const query = q.trim();
    if (query === '' || onSearch === undefined) return;
    setOpen(false);
    onSearch(query);
  }

  return (
    <div className="search-wrap" style={{ width: 360, display: 'flex', gap: 4 }}>
      <input
        className="input"
        style={{ flex: 1 }}
        type="search"
        placeholder="Search spans (name / input / output)…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => {
          if (results.length > 0 || failed) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter') submit();
        }}
      />
      {onSearch !== undefined ? (
        <button type="button" className="btn" onClick={submit} title="过滤下方表格">
          搜索
        </button>
      ) : null}
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
              results.map((hit) => <SearchHitRow key={hit.spanId} hit={hit} q={q} onPick={pick} />)
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function SearchHitRow({
  hit,
  q,
  onPick,
}: {
  hit: SearchHit;
  q: string;
  onPick: (hit: SearchHit) => void;
}) {
  const field = hit.matchedField !== undefined ? FIELD_BADGE[hit.matchedField] : undefined;
  const project = cwdTail(hit.cwd);
  const platformColor = hit.source !== undefined ? PLATFORM_COLOR[hit.source] : undefined;
  return (
    <div className="search-hit" onClick={() => onPick(hit)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {field !== undefined ? (
          <span
            style={{
              fontSize: '9px',
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: `${field.color}26`,
              color: field.color,
              flexShrink: 0,
            }}
          >
            {field.label}
          </span>
        ) : null}
        {hit.source !== undefined ? (
          <span
            style={{
              fontSize: '9px',
              fontWeight: 600,
              padding: '1px 5px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: `${platformColor ?? '#64748b'}26`,
              color: platformColor ?? '#64748b',
              flexShrink: 0,
            }}
          >
            {hit.source}
          </span>
        ) : null}
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
          {project ?? hit.sessionId.slice(0, 8)} · {fmtTime(hit.startTimeMs)}
        </span>
      </div>
      {hit.snippet ? (
        <div
          style={{
            marginTop: 2,
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-fg-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <Highlight text={hit.snippet} query={q} />
        </div>
      ) : null}
    </div>
  );
}
