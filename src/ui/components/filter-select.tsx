/**
 * FilterSelect — 极简自研下拉(过滤栏用,零依赖)。
 * 点击外部关闭;当前选中项高亮;选中即关闭。
 */
import { useEffect, useRef, useState } from 'react';

export interface FilterOption<T extends string> {
  value: T;
  label: string;
}

export function FilterSelect<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly FilterOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button type="button" className="btn" onClick={() => setOpen((v) => !v)}>
        <span style={{ color: 'var(--color-fg-faint)' }}>{label} </span>
        {current?.label ?? value} ▾
      </button>
      {open ? (
        <div
          className="card"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 40,
            minWidth: 140,
            padding: 4,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >
          {options.map((o) => (
            <div
              key={o.value}
              className={`cascade-item${o.value === value ? ' cascade-active' : ''}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
