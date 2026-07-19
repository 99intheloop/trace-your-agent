/**
 * CwdCascader — 自研多级路径级联选择器(零依赖,样式全可控)。
 *
 * 输入:distinct cwd + 计数(按计数降序)。
 * 行为:把路径按 '/' 分段建树,多列展开;单列链(无自身会话的独子节点)
 * 合并成一级标签以减少点击。选中任意一级即过滤该目录及其子目录
 * (boundary 由服务端 LIKE 'p/%' 保证)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

interface CwdItem {
  cwd: string;
  count: number;
}

interface TreeNode {
  /** 展示标签(可能被单列链合并成多段,如 "Users/zyan") */
  label: string;
  /** 该节点对应的完整路径前缀 */
  path: string;
  /** 含所有后代在内的 session 总数 */
  total: number;
  children: TreeNode[];
}

function buildTree(items: readonly CwdItem[]): TreeNode[] {
  interface Raw {
    label: string;
    path: string;
    own: number;
    total: number;
    kids: Map<string, Raw>;
  }
  const rawRoots: Map<string, Raw> = new Map();
  for (const { cwd, count } of items) {
    const segs = cwd.split('/').filter((s) => s !== '');
    let kidsMap = rawRoots;
    let node: Raw | undefined;
    let path = '';
    for (const seg of segs) {
      path += `/${seg}`;
      let next = kidsMap.get(seg);
      if (next === undefined) {
        next = { label: seg, path, own: 0, total: 0, kids: new Map() };
        kidsMap.set(seg, next);
      }
      next.total += count;
      node = next;
      kidsMap = next.kids;
    }
    if (node !== undefined) node.own += count;
  }
  const collapse = (nodes: IterableIterator<Raw>): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const n of nodes) {
      let label = n.label;
      let path = n.path;
      let kids = n.kids;
      let total = n.total;
      // 单列链合并:无自身会话且只有一个孩子 → 并入标签,少点一层
      while (n.own === 0 && kids.size === 1) {
        const only = [...kids.values()][0]!;
        label += `/${only.label}`;
        path = only.path;
        total = only.total;
        kids = only.kids;
        if (only.own > 0) break;
      }
      out.push({ label, path, total, children: collapse(kids.values()) });
    }
    out.sort((a, b) => b.total - a.total || (a.label < b.label ? -1 : 1));
    return out;
  };
  return collapse(rawRoots.values());
}

export function CwdCascader({
  cwds,
  value,
  onChange,
}: {
  cwds: readonly CwdItem[];
  value: string | undefined;
  onChange: (path: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [columns, setColumns] = useState<TreeNode[][]>([]);
  const tree = useMemo(() => buildTree(cwds), [cwds]);
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

  const openPanel = () => {
    setColumns([tree]);
    setOpen(true);
  };

  const clickNode = (depth: number, node: TreeNode) => {
    onChange(node.path);
    if (node.children.length > 0) {
      setColumns((cols) => [...cols.slice(0, depth + 1), node.children]);
    } else {
      setOpen(false);
    }
  };

  // 选中路径在每列中的高亮判断
  const isOnPath = (node: TreeNode): boolean =>
    value !== undefined && (value === node.path || value.startsWith(`${node.path}/`));

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button type="button" className="btn" onClick={() => (open ? setOpen(false) : openPanel())}>
        <span style={{ color: 'var(--color-fg-faint)' }}>目录 </span>
        {value ?? '全部'}
        {value !== undefined && (
          <span
            role="button"
            tabIndex={-1}
            style={{ marginLeft: 8, color: 'var(--color-fg-faint)', cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              onChange(undefined);
            }}
          >
            ✕
          </span>
        )}
      </button>
      {open ? (
        <div
          className="card"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 40,
            display: 'flex',
            padding: 4,
            gap: 2,
            maxWidth: '80vw',
            overflowX: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >
          {columns.map((col, depth) => (
            <div
              key={depth}
              style={{
                minWidth: 180,
                maxWidth: 260,
                maxHeight: 320,
                overflowY: 'auto',
                borderRight:
                  depth < columns.length - 1 ? '1px solid var(--color-border-default,#1e293b)' : 'none',
              }}
            >
              {depth === 0 ? (
                <div
                  className="cascade-item"
                  style={{ color: 'var(--color-fg-muted)' }}
                  onClick={() => {
                    onChange(undefined);
                    setOpen(false);
                  }}
                >
                  全部目录
                </div>
              ) : null}
              {col.map((node) => (
                <div
                  key={node.path}
                  className={`cascade-item${isOnPath(node) ? ' cascade-active' : ''}`}
                  title={node.path}
                  onClick={() => clickNode(depth, node)}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}
                  >
                    {node.label}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--color-fg-faint)', marginLeft: 6 }}>
                    {node.total}
                  </span>
                  {node.children.length > 0 ? (
                    <span style={{ marginLeft: 4, color: 'var(--color-fg-faint)' }}>›</span>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
