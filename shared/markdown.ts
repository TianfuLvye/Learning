// Markdown AST 工具：前后端共用同一套解析器，保证文本节点标识完全一致。
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit, SKIP } from 'unist-util-visit';
import { visitParents } from 'unist-util-visit-parents';
import { toString } from 'mdast-util-to-string';
import type { Root, Text, Nodes, Parents, PhrasingContent } from 'mdast';
import type { ClozeBlankPublic } from './types';

export const mdParser = unified().use(remarkParse).use(remarkGfm);

export function parseMarkdown(source: string): Root {
  return mdParser.runSync(mdParser.parse(source)) as Root;
}

/** 不允许在其内部挖空的祖先节点类型：代码、链接、图片、HTML、标题、定义等结构性内容 */
const NON_CLOZE_ANCESTORS = new Set([
  'code',
  'inlineCode',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'html',
  'heading',
  'definition',
  'yaml',
  'toml',
]);

/** 文本节点的稳定标识：基于该节点在源文本中的起始偏移量。同一内容（同一哈希）下恒定。 */
export function textNodeId(node: Text): string | null {
  const offset = node.position?.start.offset;
  return typeof offset === 'number' ? `t${offset}` : null;
}

export interface ClozeTextNode {
  id: string;
  text: string;
  /** 所在顶层块的序号 */
  block: number;
  blockType: string;
}

export interface ClozeBlockInfo {
  block: number;
  blockType: string;
  blockText: string;
  nodes: ClozeTextNode[];
}

/** 收集所有可挖空的文本节点，按阅读顺序返回 */
export function collectClozeNodes(tree: Root, minLength = 1): ClozeTextNode[] {
  const result: ClozeTextNode[] = [];
  visitParents(tree, 'text', (node, ancestors) => {
    if (ancestors.some((a) => NON_CLOZE_ANCESTORS.has(a.type))) return;
    const id = textNodeId(node);
    if (!id) return;
    if (node.value.trim().length < minLength) return;
    const top = ancestors[1];
    const block = top ? tree.children.indexOf(top as (typeof tree.children)[number]) : -1;
    result.push({ id, text: node.value, block, blockType: top?.type ?? 'unknown' });
  });
  return result;
}

/** 将可挖空节点按顶层块分组，并附带块的完整文本作为上下文 */
export function groupClozeNodesByBlock(tree: Root, nodes: ClozeTextNode[]): ClozeBlockInfo[] {
  const map = new Map<number, ClozeBlockInfo>();
  for (const n of nodes) {
    let info = map.get(n.block);
    if (!info) {
      const blockNode = tree.children[n.block];
      info = {
        block: n.block,
        blockType: n.blockType,
        blockText: blockNode ? toString(blockNode).replace(/\s+/g, ' ').trim() : '',
        nodes: [],
      };
      map.set(n.block, info);
    }
    info.nodes.push(n);
  }
  return [...map.values()];
}

export function findTextNodeById(tree: Root, id: string): Text | null {
  let found: Text | null = null;
  visit(tree, 'text', (node) => {
    if (textNodeId(node) === id) {
      found = node;
      return false;
    }
  });
  return found;
}

/**
 * remark 插件：在 AST 中将指定文本节点的指定区间替换为挖空节点。
 * 挖空节点通过 data.hName 转换为 <cloze-blank data-blank-id="..."> 元素，
 * 渲染时再映射为输入框组件，原有的加粗、链接等结构保持不变。
 */
export function remarkCloze(options: { blanks?: ClozeBlankPublic[] } = {}) {
  const blanks = options.blanks ?? [];
  return (tree: Root) => {
    if (blanks.length === 0) return;
    const byNode = new Map<string, ClozeBlankPublic[]>();
    for (const b of blanks) {
      const list = byNode.get(b.nodeId) ?? [];
      list.push(b);
      byNode.set(b.nodeId, list);
    }
    for (const list of byNode.values()) list.sort((a, b) => a.start - b.start);

    visitParents(tree, 'text', (node, ancestors) => {
      const id = textNodeId(node);
      const list = id ? byNode.get(id) : undefined;
      if (!list) return;
      if (ancestors.some((a) => NON_CLOZE_ANCESTORS.has(a.type))) return;
      const parent = ancestors[ancestors.length - 1] as Parents;
      const index = (parent.children as Nodes[]).indexOf(node);
      if (index < 0) return;

      const segments: PhrasingContent[] = [];
      let cursor = 0;
      for (const b of list) {
        if (b.start < cursor || b.end > node.value.length || b.start >= b.end) continue;
        if (b.start > cursor) segments.push({ type: 'text', value: node.value.slice(cursor, b.start) });
        segments.push({
          type: 'clozeBlank',
          data: {
            hName: 'cloze-blank',
            hProperties: { 'data-blank-id': b.id, 'data-length': String(b.length) },
            hChildren: [],
          },
        } as unknown as PhrasingContent);
        cursor = b.end;
      }
      if (cursor < node.value.length) segments.push({ type: 'text', value: node.value.slice(cursor) });
      (parent.children as Nodes[]).splice(index, 1, ...(segments as Nodes[]));
      return [SKIP, index + segments.length];
    });
  };
}

/** 文档标题：首个一级标题，否则使用文件名 */
export function extractTitle(tree: Root, fallback: string): string {
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 1) {
      const t = toString(node).trim();
      if (t) return t;
    }
  }
  return fallback;
}

/**
 * 生成发送给模型的文章文本：保留 Markdown 结构，但将图片替换为文字占位，
 * 让模型明确知道图片内容不可见，只能依据文字出题。
 */
export function toAiText(source: string, tree?: Root): string {
  const root = tree ?? parseMarkdown(source);
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  visit(root, (node) => {
    if (node.type === 'image' || node.type === 'imageReference') {
      const alt = (node as { alt?: string | null }).alt?.trim();
      const s = node.position?.start.offset;
      const e = node.position?.end.offset;
      if (typeof s === 'number' && typeof e === 'number') {
        ranges.push({ start: s, end: e, text: alt ? `[图片：${alt}（图片内容不可见）]` : '[图片（内容不可见）]' });
      }
      return SKIP;
    }
    if (node.type === 'html' && /<img\b/i.test(node.value)) {
      const s = node.position?.start.offset;
      const e = node.position?.end.offset;
      if (typeof s === 'number' && typeof e === 'number') {
        ranges.push({ start: s, end: e, text: '[图片（内容不可见）]' });
      }
    }
  });
  ranges.sort((a, b) => b.start - a.start);
  let out = source;
  for (const r of ranges) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  return out;
}

/** 纯文本（用于校验模型引用的原文依据） */
export function toPlainText(tree: Root): string {
  return tree.children.map((c) => toString(c)).join('\n');
}
