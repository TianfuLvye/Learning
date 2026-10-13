import { useMemo, useState } from 'react';
import { ChevronRight, FileText, Folder, Layers, PanelLeftClose } from 'lucide-react';
import type { TreeDirNode, TreeNode } from '@shared/types';

interface Props {
  root: TreeDirNode | null;
  currentPath: string | null;
  onSelect: (path: string) => void;
  collapsed: boolean;
  onCollapse: () => void;
}

const dirsKey = (nodes: TreeDirNode[]) => nodes.map((n) => n.path).join('|');

export function Sidebar({ root, currentPath, onSelect, collapsed, onCollapse }: Props) {
  // 默认展开顶层目录与当前文档所在的目录链
  const initial = useMemo(() => {
    const open = new Set<string>();
    if (root) for (const child of root.children) if (child.type === 'dir') open.add(child.path);
    if (currentPath) {
      const parts = currentPath.split('/');
      for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join('/'));
    }
    return open;
  }, [root?.path, dirsKey((root?.children.filter((c) => c.type === 'dir') as TreeDirNode[]) ?? [])]);

  const [openOverride, setOpenOverride] = useState<Set<string> | null>(null);
  const open = openOverride ?? initial;

  const toggle = (path: string) => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpenOverride(next);
  };

  const stats = root?.stats ?? { total: 0, completed: 0, inProgress: 0 };
  const percent = stats.total ? Math.round((stats.completed / stats.total) * 100) : 0;

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`} aria-label="知识目录">
      <div className="sidebar__head">
        <Layers size={17} color="var(--accent)" />
        <span className="sidebar__brand">知识目录</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onCollapse} title="收起目录" aria-label="收起目录">
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className="progress-card">
        <div className="progress-card__row">
          <span className="progress-card__label">总体进度</span>
          <span className="progress-card__value">{percent}%</span>
        </div>
        <div className="bar">
          <div className="bar__fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="progress-card__sub">
          <span>已完成 {stats.completed}</span>
          <span>学习中 {stats.inProgress}</span>
          <span>共 {stats.total} 篇</span>
        </div>
      </div>

      <div className="sidebar__body">
        {root && root.children.length > 0 ? (
          <ul className="tree">
            {root.children.map((child) => (
              <TreeRow key={child.path} node={child} depth={0} open={open} toggle={toggle} currentPath={currentPath} onSelect={onSelect} />
            ))}
          </ul>
        ) : (
          <div className="state" style={{ padding: '24px 12px' }}>
            <div className="state__title">learn/ 目录还是空的</div>
            <div className="state__desc">把 Markdown 文件放进 learn/ 目录（支持任意层级子目录），目录树会自动更新。</div>
          </div>
        )}
      </div>
    </aside>
  );
}

function TreeRow({
  node,
  depth,
  open,
  toggle,
  currentPath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  open: Set<string>;
  toggle: (p: string) => void;
  currentPath: string | null;
  onSelect: (p: string) => void;
}) {
  if (node.type === 'file') {
    const active = node.path === currentPath;
    return (
      <li>
        <button
          className={`tree__row ${active ? 'tree__row--active' : ''}`}
          onClick={() => onSelect(node.path)}
          title={node.path}
          aria-current={active ? 'true' : undefined}
        >
          <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
            <span className={`tree__dot tree__dot--${node.status}`} />
          </span>
          <FileText size={14} style={{ flexShrink: 0, opacity: 0.65 }} />
          <span className="tree__label">{node.name.replace(/\.(md|markdown)$/i, '')}</span>
        </button>
      </li>
    );
  }

  const isOpen = open.has(node.path);
  const percent = node.stats.total ? Math.round((node.stats.completed / node.stats.total) * 100) : 0;
  return (
    <li>
      <button className="tree__row" onClick={() => toggle(node.path)} aria-expanded={isOpen} title={node.path}>
        <ChevronRight size={14} className={`tree__chevron ${isOpen ? 'tree__chevron--open' : ''}`} />
        <Folder size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
        <span className="tree__label">{node.name}</span>
        <span className="tree__meta">
          {node.stats.completed}/{node.stats.total}
        </span>
      </button>
      {isOpen && (
        <div style={{ margin: '2px 0 4px 12px' }}>
          <div className="bar" style={{ height: 3, marginBottom: 2 }}>
            <div className="bar__fill" style={{ width: `${percent}%`, background: percent === 100 ? 'var(--green)' : 'var(--accent)' }} />
          </div>
          <ul className="tree" style={{ marginLeft: 0, borderLeft: 'none', paddingLeft: 0 }}>
            {node.children.map((child) => (
              <TreeRow key={child.path} node={child} depth={depth + 1} open={open} toggle={toggle} currentPath={currentPath} onSelect={onSelect} />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
