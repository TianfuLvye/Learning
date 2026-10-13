// Markdown 渲染管线：
// remark-parse / remark-gfm → (AST 中插入挖空节点) → remark-rehype → rehype-raw → rehype-sanitize → rehype-highlight
// 挖空通过替换 AST 文本节点实现，不对 Markdown 源字符串做任何替换。
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import type { Root as HastRoot, Element, RootContent } from 'hast';
import type { Root as MdastRoot } from 'mdast';
import type { ReactNode } from 'react';
import { remarkCloze } from '@shared/markdown';
import type { ClozeBlankPublic } from '@shared/types';
import { classifyUrl, isMarkdownPath, resolveRelative, safeDecode, splitHash } from '@shared/paths';
import { assetUrl } from './api';

/** 允许经过安全过滤后保留的标签与属性：常见排版标签 + 本项目的挖空元素 */
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'cloze-blank',
    'details',
    'summary',
    'kbd',
    'abbr',
    'sup',
    'sub',
    'mark',
    'figure',
    'figcaption',
  ],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className', 'id'],
    'cloze-blank': ['dataBlankId', 'dataLength'],
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    span: [...(defaultSchema.attributes?.span ?? []), 'className'],
    img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height'],
    a: [...(defaultSchema.attributes?.a ?? []), 'target', 'rel'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto', 'tel'],
    src: ['http', 'https'],
  },
};

export interface RenderDeps {
  /** 当前文档路径，用于解析相对图片与链接 */
  docPath: string;
  onNavigate?: (path: string, hash: string) => void;
  /** 不安全或越界的链接/图片地址 */
  onBlocked?: (reason: string) => void;
}

export interface RenderResult {
  tree: HastRoot;
  /** 顶层块列表，供分页使用 */
  blocks: RootContent[];
}

const processor = unified()
  .use(remarkParse, { gfm: true })
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, sanitizeSchema as never)
  .use(rehypeHighlight, { detect: true, ignoreMissing: true });

/** 解析 → 插入挖空 → 转为 hast（只跑一次管线） */
export function buildTree(content: string, blanks: ClozeBlankPublic[] = []): RenderResult {
  const mdast = processor.parse(content) as MdastRoot;
  remarkCloze({ blanks })(mdast as never);
  const tree = processor.runSync(mdast) as unknown as HastRoot;
  // rehype-raw 会在元素之间插入纯空白文本节点，分页时需要剔除，
  // 否则会出现大量空块并影响装箱计算。
  tree.children = tree.children.filter((c) => !(c.type === 'text' && !(c.value ?? '').trim()));
  return { tree, blocks: tree.children as RootContent[] };
}

function renderNode(tree: HastRoot, components: Record<string, unknown>): ReactNode {
  return toJsxRuntime(tree, {
    Fragment,
    jsx: jsx as never,
    jsxs: jsxs as never,
    passNode: true,
    development: false,
    components: { ...defaultComponents, ...components } as never,
  }) as ReactNode;
}

export function renderTree(tree: HastRoot, components: Record<string, unknown> = {}): ReactNode {
  return renderNode(tree, components);
}

/** 渲染单个顶层块（分页阅读按块渲染） */
export function renderBlock(block: RootContent, components: Record<string, unknown> = {}): ReactNode {
  return renderNode({ type: 'root', children: [block] }, components);
}

/** 判断 hast 节点是否为挖空元素 */
export function asClozeBlank(node: RootContent | Element): boolean {
  return (node as Element).tagName === 'cloze-blank';
}

/** 从挖空元素上读取属性 */
export function clozePropsFrom(node: Element): { blankId: string; length: number } | null {
  const props = node.properties ?? {};
  const raw = props['data-blank-id'];
  if (typeof raw !== 'string' || !raw) return null;
  const len = Number(props['data-length'] ?? 0);
  return { blankId: raw, length: Number.isFinite(len) && len > 0 ? len : 4 };
}

const defaultComponents: Record<string, unknown> = {
  // 链接统一由 useUrlHandlers 处理，这里只提供基础样式钩子
  a: ({ children, ...props }: { children?: ReactNode }) => (
    <a {...props} data-mdlink="1">
      {children}
    </a>
  ),
};

export function createUrlHandlers(deps: RenderDeps) {
  const block = (reason: string) => deps.onBlocked?.(reason);

  const onLinkClick = (raw: string | undefined, e: React.MouseEvent): void => {
    if (!raw) return;
    const kind = classifyUrl(raw);
    if (kind === 'unsafe') {
      e.preventDefault();
      block('已阻止不安全的链接协议');
      return;
    }
    if (kind === 'external' || kind === 'anchor') return; // 交给浏览器处理
    e.preventDefault();
    const { path, hash } = splitHash(raw);
    const resolved = resolveRelative(deps.docPath, safeDecode(path));
    if (!resolved) {
      block('链接指向学习目录之外的路径，已阻止');
      return;
    }
    if (isMarkdownPath(resolved)) deps.onNavigate?.(resolved, hash);
    else window.open(assetUrl(resolved), '_blank', 'noopener,noreferrer');
  };

  const resolveSrc = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    if (/^data:image\//i.test(raw)) return raw;
    const kind = classifyUrl(raw);
    if (kind === 'unsafe') {
      block('已阻止不安全的图片地址');
      return undefined;
    }
    if (kind === 'external' || kind === 'anchor') return raw;
    const { path } = splitHash(raw);
    const resolved = resolveRelative(deps.docPath, safeDecode(path));
    if (!resolved) {
      block('图片指向学习目录之外的路径，已阻止');
      return undefined;
    }
    return assetUrl(resolved);
  };

  return { onLinkClick, resolveSrc };
}
