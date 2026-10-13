import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleAlert,
  FileText,
  Loader2,
  PanelLeftOpen,
  RefreshCw,
  Settings2,
  Sparkles,
  Type,
} from 'lucide-react';
import type { AppConfigResponse, DocResponse, TreeDirNode } from '@shared/types';
import { api, ApiError } from './lib/api';
import { useExercises, useReading, useSettings, type AppMode } from './store';
import { Sidebar } from './components/Sidebar';
import { ReadingView } from './components/ReadingView';
import { PracticeMode } from './components/PracticeMode';
import { ReviewMode } from './components/ReviewMode';
import { Toasts, toast } from './components/Toasts';

const MODES: Array<[AppMode, string]> = [
  ['read', '阅读'],
  ['practice', '练习'],
  ['review', '复习反馈'],
];

export default function App() {
  const settings = useSettings();
  const { positions, setPosition } = useReading();
  const { sets, clear: clearExercises, loadCached } = useExercises();

  const [config, setConfig] = useState<AppConfigResponse | null>(null);
  const [root, setRoot] = useState<TreeDirNode | null>(null);
  const [doc, setDoc] = useState<DocResponse | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const lastPath = useRef<string | null>(null);

  const refreshTree = useCallback(async () => {
    try {
      const t = await api.tree();
      setRoot(t.root);
      setTreeError(null);
    } catch (err) {
      setTreeError((err as ApiError).message);
    }
  }, []);

  const openDoc = useCallback(
    async (path: string) => {
      setDocLoading(true);
      setDocError(null);
      try {
        if (lastPath.current !== path) clearExercises();
        lastPath.current = path;
        const [docRes] = await Promise.all([api.doc(path), api.openDoc(path)]);
        setDoc({ ...docRes, status: 'in_progress' });
        settings.setCurrentPath(path);
        void loadCached(path);
        void refreshTree();
        setMobileNavOpen(false);
      } catch (err) {
        setDocError((err as ApiError).message);
      } finally {
        setDocLoading(false);
      }
    },
    [clearExercises, loadCached, refreshTree, settings],
  );

  // 初始化
  useEffect(() => {
    void (async () => {
      try {
        setConfig(await api.config());
      } catch {
        /* 配置接口失败不阻塞阅读 */
      }
      await refreshTree();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 目录加载完成后恢复上次打开的文档
  useEffect(() => {
    if (doc || docLoading || !root) return;
    const all = collectFiles(root);
    if (all.length === 0) return;
    const target = settings.currentPath && all.includes(settings.currentPath) ? settings.currentPath : all[0];
    void openDoc(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, doc, docLoading]);

  // 文件变化时刷新目录与当前文档
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('message', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as { type: string; path?: string };
        if (payload.type === 'tree') void refreshTree();
        if (payload.type === 'doc' && payload.path && payload.path === lastPath.current) {
          void api.doc(payload.path).then((d) => {
            setDoc(d);
            lastPath.current = d.path;
          });
        }
      } catch {
        /* 忽略无法解析的事件 */
      }
    });
    return () => source.close();
  }, [refreshTree]);

  const gotoReview = useCallback(() => settings.setMode('review'), [settings]);

  const markStatus = async (status: 'completed' | 'in_progress' | 'not_started') => {
    if (!doc) return;
    try {
      const res = await api.setStatus(doc.path, status);
      setDoc((d) => (d ? { ...d, status: res.status } : d));
      await refreshTree();
      toast(status === 'completed' ? '已标记为「已完成」' : status === 'in_progress' ? '已重新开始学习' : '已重置为未开始');
    } catch (err) {
      toast((err as ApiError).message);
    }
  };

  const mdStyle = useMemo(
    () =>
      ({
        '--md-font-size': `${settings.fontSize}px`,
        '--md-line-height': settings.lineHeight,
        '--md-width': settings.readWidth,
      }) as React.CSSProperties,
    [settings.fontSize, settings.lineHeight, settings.readWidth],
  );

  const readingProps = doc
    ? {
        content: doc.content,
        docPath: doc.path,
        onNavigate: (p: string) => void openDoc(p),
        onBlocked: (reason: string) => toast(reason),
      }
    : null;

  const renderWorkspace = () => {
    if (!doc || !readingProps) {
      if (docLoading) {
        return (
          <div className="state">
            <div className="spinner" />
            <div className="state__title">正在加载文档…</div>
          </div>
        );
      }
      return (
        <div className="state">
          <FileText size={26} color="var(--text-3)" />
          <div className="state__title">{treeError ? '无法连接到本地服务' : '还没有选择文档'}</div>
          <div className="state__desc">
            {treeError ?? '从左侧目录中选择一篇 Markdown 文档开始学习，或把新的 Markdown 文件放入 learn/ 目录。'}
          </div>
          <button className="btn" onClick={() => void refreshTree()}>
            <RefreshCw size={14} /> 重新扫描目录
          </button>
        </div>
      );
    }

    if (settings.mode === 'read') {
      return (
        <ReadingView
          {...readingProps}
          docKey={doc.path + doc.hash}
          initialBlock={positions[doc.path] ?? 0}
          onPositionChange={(b) => setPosition(doc.path, b)}
        />
      );
    }
    if (settings.mode === 'practice') {
      return (
        <PracticeMode
          docPath={doc.path}
          docHash={doc.hash}
          title={doc.title}
          content={doc.content}
          aiConfigured={config?.aiConfigured ?? false}
          onNavigate={(p) => void openDoc(p)}
          onBlocked={(r) => toast(r)}
          onGotoReview={gotoReview}
        />
      );
    }
    return (
      <ReviewMode
        docPath={doc.path}
        content={doc.content}
        onNavigate={(p) => void openDoc(p)}
        onBlocked={(r) => toast(r)}
      />
    );
  };

  const docPrefix = doc && doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/') + 1) : '';
  const docTitle = doc?.title ?? 'Markdown 学习系统';
  const hasExercises = Boolean(sets.mcq || sets.cloze || sets.qa);

  return (
    <div className="app" style={mdStyle}>
      <Sidebar
        root={root}
        currentPath={doc?.path ?? null}
        onSelect={(p) => void openDoc(p)}
        collapsed={settings.sidebarCollapsed && !mobileNavOpen}
        onCollapse={() => settings.setSidebarCollapsed(true)}
      />
      {mobileNavOpen && <div className="overlay" onClick={() => setMobileNavOpen(false)} />}

      <div className="main">
        <header className="topbar">
          {settings.sidebarCollapsed && (
            <button className="icon-btn" onClick={() => settings.setSidebarCollapsed(false)} title="展开目录" aria-label="展开目录">
              <PanelLeftOpen size={17} />
            </button>
          )}
          <div className="topbar__heading">
            {docPrefix && <span className="topbar__path">{docPrefix}</span>}
            <span className="topbar__title">{docTitle}</span>
          </div>
          <span className="topbar__spacer" />

          <div className="segmented" role="tablist" aria-label="学习模式">
            {MODES.map(([mode, label]) => (
              <button key={mode} role="tab" aria-selected={settings.mode === mode} onClick={() => settings.setMode(mode)}>
                {label}
                {mode === 'practice' && hasExercises ? ' •' : ''}
              </button>
            ))}
          </div>

          <div style={{ position: 'relative' }}>
            <button className="icon-btn" onClick={() => setSettingsOpen((v) => !v)} title="阅读设置" aria-label="阅读设置">
              <Type size={17} />
            </button>
            {settingsOpen && (
              <div className="popover" onMouseLeave={() => setSettingsOpen(false)}>
                <div className="popover__row">
                  <span className="popover__label">字号 {settings.fontSize}px</span>
                  <input type="range" min={13} max={26} step={1} value={settings.fontSize} onChange={(e) => settings.setFontSize(Number(e.target.value))} />
                </div>
                <div className="popover__row">
                  <span className="popover__label">行高 {settings.lineHeight.toFixed(2)}</span>
                  <input type="range" min={1.4} max={2.4} step={0.05} value={settings.lineHeight} onChange={(e) => settings.setLineHeight(Number(e.target.value))} />
                </div>
                <div className="popover__row">
                  <span className="popover__label">阅读宽度 {settings.readWidth}em</span>
                  <input type="range" min={22} max={60} step={1} value={settings.readWidth} onChange={(e) => settings.setReadWidth(Number(e.target.value))} />
                </div>
                <button className="btn btn--ghost" style={{ width: '100%', justifyContent: 'center' }} onClick={() => settings.reset()}>
                  恢复默认
                </button>
              </div>
            )}
          </div>

          {doc && (
            <button
              className="btn"
              onClick={() => markStatus(doc.status === 'completed' ? 'in_progress' : 'completed')}
              title={doc.status === 'completed' ? '重新学习（保留历史成绩）' : '标记为已完成'}
            >
              {doc.status === 'completed' ? <RefreshCw size={14} /> : <Sparkles size={14} />}
              <span className="btn__label">{doc.status === 'completed' ? '重新学习' : '标记完成'}</span>
            </button>
          )}
        </header>

        {!config?.aiConfigured && config && (
          <div className="banner" style={{ margin: '10px 18px 0' }}>
            <CircleAlert size={15} />
            未配置 DeepSeek API Key：阅读、目录与进度管理可以正常使用，AI 练习功能会提示配置说明。请在项目根目录
            <code>.env</code>
            中设置 <code>DEEPSEEK_API_KEY</code>。
          </div>
        )}
        {docError && (
          <div className="banner banner--error" style={{ margin: '10px 18px 0' }}>
            <CircleAlert size={15} /> {docError}
          </div>
        )}

        <div className="workspace">{renderWorkspace()}</div>
      </div>

      <Toasts />
      {docLoading && (
        <div style={{ position: 'fixed', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 120 }}>
          <span className="pill pill--accent">
            <Loader2 size={13} /> 加载中
          </span>
        </div>
      )}
    </div>
  );
}

function collectFiles(root: TreeDirNode): string[] {
  const out: string[] = [];
  const walk = (node: TreeDirNode) => {
    for (const child of node.children) {
      if (child.type === 'file') out.push(child.path);
      else walk(child);
    }
  };
  walk(root);
  return out;
}
