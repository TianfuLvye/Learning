// Markdown 渲染视图：统一处理链接/图片解析、挖空输入框注入与安全提示
import { useCallback, useMemo, useRef, type ComponentType, type ReactNode } from 'react';
import type { ClozeBlankPublic, ClozeBlankResult } from '@shared/types';
import { buildTree, createUrlHandlers, renderBlock, renderTree, type RenderDeps, type RenderResult } from '../lib/markdown';
import { ClozeBlank } from './ClozeBlank';

export interface MarkdownViewProps {
  content: string;
  docPath: string;
  blanks?: ClozeBlankPublic[];
  clozeValues?: Record<string, string>;
  onClozeChange?: (id: string, value: string) => void;
  clozeResults?: Record<string, ClozeBlankResult>;
  clozeDisabled?: boolean;
  onNavigate?: (path: string, hash: string) => void;
  onBlocked?: (reason: string) => void;
  className?: string;
  measureWidth?: boolean;
}

type ClozeComponent = ComponentType<{ blankId?: string }>;
interface Components extends Record<string, ComponentType<never>> {
  a: ComponentType<never>;
  img: ComponentType<never>;
  'cloze-blank': ComponentType<never>;
}

function useRenderContext(props: MarkdownViewProps) {
  const tree = useMemo(() => buildTree(props.content, props.blanks ?? []), [props.content, props.blanks]);

  // 最新的回调放在 ref 中，使组件映射保持稳定，避免输入框在每次渲染时重建
  const latest = useRef(props);
  latest.current = props;

  const deps: RenderDeps = useMemo(
    () => ({
      docPath: props.docPath,
      onNavigate: (p, h) => latest.current.onNavigate?.(p, h),
      onBlocked: (r) => latest.current.onBlocked?.(r),
    }),
    [props.docPath],
  );
  const handlers = useMemo(() => createUrlHandlers(deps), [deps]);
  const blankById = useMemo(() => new Map((props.blanks ?? []).map((b) => [b.id, b])), [props.blanks]);

  const components = useMemo<Components>(() => {
    const Anchor = ({ href, children, ...rest }: { href?: string; children?: ReactNode }) => (
      <a
        href={href}
        {...rest}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) return; // 允许在新标签页打开
          handlers.onLinkClick(href, e);
        }}
      >
        {children}
      </a>
    );
    const Image = ({ src, alt, ...rest }: { src?: string; alt?: string }) => {
      const resolved = handlers.resolveSrc(src);
      if (!resolved) return <span className="pill pill--orange">图片已被安全策略阻止</span>;
      return (
        <img
          src={resolved}
          alt={alt ?? ''}
          loading="lazy"
          decoding="async"
          {...rest}
          onError={(e) => {
            // 图片加载失败时显示替代文字，避免空白
            const img = e.currentTarget;
            img.style.display = 'none';
            const tip = document.createElement('span');
            tip.className = 'pill pill--orange';
            tip.textContent = `图片无法加载${alt ? `：${alt}` : ''}`;
            img.after(tip);
          }}
        />
      );
    };
    // hast-util-to-jsx-runtime passes kebab-case data-* as camelCase (dataBlankId)
    // but also may pass them raw; accept both forms
    const Cloze = (raw: Record<string, unknown>) => {
      const id = String(raw.dataBlankId ?? raw['data-blank-id'] ?? '');
      const blank = blankById.get(id);
      if (!blank) return <span className="cloze-blank cloze-blank--static">＿＿＿</span>;
      const result = latest.current.clozeResults?.[id];
      if (result) return <ClozeBlank blank={blank} value="" result={result} />;
      return (
        <ClozeBlank
          blank={blank}
          value={latest.current.clozeValues?.[id] ?? ''}
          disabled={latest.current.clozeDisabled}
          onChange={(v) => latest.current.onClozeChange?.(id, v)}
        />
      );
    };
    return { a: Anchor, img: Image, 'cloze-blank': Cloze } as unknown as Components;
  }, [handlers, blankById]);

  return { tree, components };
}

function classes(props: MarkdownViewProps) {
  return ['md', props.className, props.measureWidth ? 'md--measure' : ''].filter(Boolean).join(' ');
}

/** 连续阅读：整篇渲染 */
export function MarkdownView(props: MarkdownViewProps) {
  const { tree, components } = useRenderContext(props);
  return <div className={classes(props)}>{renderTree(tree.tree, components as never)}</div>;
}

/** 分页阅读：按顶层块渲染，供分页计算与逐页展示 */
export function useMarkdownBlocks(props: MarkdownViewProps) {
  const { tree, components } = useRenderContext(props);
  const render = useCallback((index: number) => renderBlock(tree.blocks[index], components as never), [tree, components]);
  // 标题块需要与下一个块保持在同一页（避免孤立的标题）
  const headingFlags = useMemo(
    () => tree.blocks.map((b) => b.type === 'element' && /^h[1-6]$/.test(b.tagName)),
    [tree],
  );
  return { blocks: tree.blocks.length, className: classes(props), renderBlock: render, headingFlags };
}
