/**
 * VerdictEditor — 详情页头部的人工标注控件(eval 方向一)。
 *
 * verdict 三态切换(pass / partial / fail,再点一次取消)+ task_type 下拉 +
 * note 输入(blur/Enter 保存)。乐观更新,失败回滚并提示。
 */
import { useState } from 'react';
import { api } from '../lib/api.js';
import type { SessionSummary } from '../lib/types.js';

type Verdict = NonNullable<SessionSummary['verdict']>;
type TaskType = NonNullable<SessionSummary['taskType']>;

const VERDICTS: Array<{ value: Verdict; label: string; color: string }> = [
  { value: 'pass', label: '✓ pass', color: 'var(--color-status-ok)' },
  { value: 'partial', label: '~ partial', color: 'var(--color-kind-pipeline)' },
  { value: 'fail', label: '✗ fail', color: 'var(--color-status-error)' },
];

const TASK_TYPES: Array<{ value: TaskType; label: string }> = [
  { value: 'feature', label: 'feature' },
  { value: 'fix', label: 'fix' },
  { value: 'change', label: 'change' },
  { value: 'ask', label: 'ask' },
];

export function VerdictEditor({
  summary,
  onSaved,
}: {
  summary: SessionSummary;
  onSaved: (next: SessionSummary) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState(summary.note ?? '');

  const save = (patch: Parameters<typeof api.setVerdict>[1]) => {
    setSaving(true);
    setFailed(false);
    api
      .setVerdict(summary.sessionId, patch)
      .then(onSaved)
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, color: 'var(--color-fg-faint)', fontFamily: 'var(--font-mono)' }}>
        标注
      </span>
      {VERDICTS.map((v) => {
        const active = summary.verdict === v.value;
        return (
          <button
            key={v.value}
            type="button"
            className="btn"
            disabled={saving}
            onClick={() => save({ verdict: active ? null : v.value })}
            style={{
              fontSize: 11,
              color: v.color,
              background: active
                ? `color-mix(in srgb, ${v.color} 16%, var(--color-bg-card))`
                : undefined,
              borderColor: active ? v.color : undefined,
            }}
          >
            {v.label}
          </button>
        );
      })}
      <select
        className="btn"
        style={{ fontSize: 11, color: 'var(--color-fg-muted)', background: 'var(--color-bg-card)' }}
        value={summary.taskType ?? ''}
        disabled={saving}
        onChange={(e) => {
          const v = e.target.value;
          save({ taskType: v === '' ? null : (v as TaskType) });
        }}
      >
        <option value="">type…</option>
        {TASK_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <input
        className="input"
        style={{ flex: 1, minWidth: 160, fontSize: 11 }}
        placeholder="备注(blur/Enter 保存)"
        defaultValue={summary.note ?? ''}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note !== (summary.note ?? '')) save({ note: note === '' ? null : note });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {saving ? <span style={{ fontSize: 10, color: 'var(--color-fg-faint)' }}>saving…</span> : null}
      {failed ? (
        <span style={{ fontSize: 10, color: 'var(--color-status-error)' }}>保存失败</span>
      ) : null}
    </div>
  );
}
