/**
 * SuccessPanel — sessions 页的可折叠成功率面板(eval 方向一)。
 *
 * 四个分组 tab:平台 / 仓库 / 任务类型 / 周趋势。仅统计已标注 session;
 * 每条 = 分组名 + 总数 + pass/partial/fail 堆叠条 + 成功率百分比。
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { SuccessStat } from '../lib/types.js';

type GroupBy = 'source' | 'cwd' | 'taskType' | 'week';

const TABS: Array<{ key: GroupBy; label: string }> = [
  { key: 'source', label: '平台' },
  { key: 'cwd', label: '仓库' },
  { key: 'taskType', label: '任务类型' },
  { key: 'week', label: '周趋势' },
];

function rateText(s: SuccessStat): string {
  if (s.total === 0) return '—';
  return `${Math.round((s.pass / s.total) * 100)}%`;
}

export function SuccessPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<GroupBy>('source');
  const [stats, setStats] = useState<SuccessStat[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .successStats(tab)
      .then((d) => {
        if (alive) setStats(d.stats);
      })
      .catch(() => {
        if (alive) setStats([]);
      });
    return () => {
      alive = false;
    };
  }, [open, tab]);

  return (
    <div className="card" style={{ marginBottom: 'var(--spacing-4)', overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-3)',
          padding: 'var(--spacing-2) var(--spacing-3)',
          cursor: 'pointer',
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ fontSize: 10, color: 'var(--color-fg-faint)' }}>{open ? '▼' : '▶'}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-fg-default)' }}>
          成功率
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-fg-faint)' }}>
          基于人工标注(详情页头部)
        </span>
        {open ? (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`tab${tab === t.key ? ' tab-active' : ''}`}
                style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setTab(t.key);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {open ? (
        <div style={{ padding: '0 var(--spacing-3) var(--spacing-3)' }}>
          {stats === null ? (
            <div style={{ fontSize: 11, color: 'var(--color-fg-faint)', padding: 8 }}>加载中…</div>
          ) : stats.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--color-fg-faint)', padding: 8 }}>
              还没有标注数据——打开任意 session 详情页,在头部点 pass / partial / fail 即可开始积累。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {stats.map((s) => {
                const passPct = (s.pass / s.total) * 100;
                const partialPct = (s.partial / s.total) * 100;
                const failPct = (s.fail / s.total) * 100;
                return (
                  <div
                    key={s.key}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11 }}
                  >
                    <span
                      style={{
                        width: 220,
                        flexShrink: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--color-fg-default)',
                      }}
                      title={s.key}
                    >
                      {s.key}
                    </span>
                    <span
                      style={{
                        width: 40,
                        flexShrink: 0,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--color-fg-faint)',
                      }}
                    >
                      n={s.total}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        height: 8,
                        display: 'flex',
                        borderRadius: 4,
                        overflow: 'hidden',
                        background: 'var(--color-border-default)',
                      }}
                    >
                      <span style={{ width: `${passPct}%`, background: 'var(--color-status-ok)' }} />
                      <span
                        style={{ width: `${partialPct}%`, background: 'var(--color-kind-pipeline)' }}
                      />
                      <span
                        style={{ width: `${failPct}%`, background: 'var(--color-status-error)' }}
                      />
                    </span>
                    <span
                      style={{
                        width: 44,
                        flexShrink: 0,
                        textAlign: 'right',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--color-status-ok)',
                      }}
                    >
                      {rateText(s)}
                    </span>
                    <span
                      style={{
                        width: 110,
                        flexShrink: 0,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        color: 'var(--color-fg-faint)',
                      }}
                    >
                      {s.pass}/{s.partial}/{s.fail}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
