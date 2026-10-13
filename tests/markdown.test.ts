import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { collectClozeNodes, extractTitle, findTextNodeById, parseMarkdown, remarkCloze, toAiText } from '../shared/markdown';
import { countOccurrences, indexOfOccurrence, normalizeAnswer, quoteAppearsIn } from '../shared/normalize';
import { classifyUrl, resolveRelative, splitHash } from '../shared/paths';

describe('Markdown AST', () => {
  it('为文本节点生成稳定标识，并与解析器位置一致', () => {
    const src = '# 标题\n\n进程是**资源分配**的基本单位。\n';
    const tree = parseMarkdown(src);
    const nodes = collectClozeNodes(tree);
    // 标题被跳过；段落中加粗部分的文本节点同样可以挖空
    expect(nodes.map((n) => n.text)).toEqual(['进程是', '资源分配', '的基本单位。']);
    const first = findTextNodeById(tree, nodes[0].id)!;
    expect(src.slice(first.position!.start.offset!, first.position!.end.offset!)).toBe('进程是');
  });

  it('跳过代码、行内代码、链接、图片、标题与 HTML', () => {
    const src = [
      '# 标题',
      '',
      '正文 [链接文字](a.md) 结尾。',
      '',
      '![图片说明](img.png)',
      '',
      '`行内代码`',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '<div>html 内容</div>',
      '',
      '> 引用正文',
    ].join('\n');
    const texts = collectClozeNodes(parseMarkdown(src)).map((n) => n.text);
    expect(texts).toContain('正文 ');
    expect(texts).toContain(' 结尾。');
    expect(texts).toContain('引用正文');
    expect(texts.join()).not.toContain('链接文字');
    expect(texts.join()).not.toContain('图片说明');
    expect(texts.join()).not.toContain('行内代码');
    expect(texts.join()).not.toContain('const a');
    expect(texts.join()).not.toContain('标题');
  });

  it('表格单元格与列表项参与挖空，代码块不参与', () => {
    const src = ['| 状态 | 含义 |', '| --- | --- |', '| 就绪态 | 等待 CPU |', '', '- 项目一', '', '```c', 'int x;', '```'].join('\n');
    const texts = collectClozeNodes(parseMarkdown(src)).map((n) => n.text);
    expect(texts).toContain('就绪态');
    expect(texts).toContain('等待 CPU');
    expect(texts).toContain('项目一');
    expect(texts).not.toContain('int x;');
  });

  it('重复词语可按出现序号精确定位', () => {
    const tree = parseMarkdown('进程与进程之间的调度。');
    const node = collectClozeNodes(tree)[0];
    expect(countOccurrences(node.text, '进程')).toBe(2);
    expect(indexOfOccurrence(node.text, '进程', 1)).toBe(0);
    expect(indexOfOccurrence(node.text, '进程', 2)).toBe(3);
    expect(indexOfOccurrence(node.text, '进程', 3)).toBe(-1);
  });

  it('挖空插件在 AST 层替换文本，保留加粗等行内结构', () => {
    const src = '进程是**资源分配**的基本单位。';
    const tree = parseMarkdown(src);
    const target = collectClozeNodes(tree).find((n) => n.text === '资源分配')!;
    const start = target.text.indexOf('资源分配');
    remarkCloze({ blanks: [{ id: 'b1', nodeId: target.id, start, end: start + 4, length: 4 }] })(tree as never);
    const strong = tree.children[0] as { children: Array<{ type: string; children?: Array<{ type: string; data?: unknown }> }> };
    const paragraph = strong.children[1];
    expect(paragraph.type).toBe('strong');
    expect(paragraph.children!.map((c) => c.type)).toEqual(['clozeBlank']);
    expect(JSON.stringify(tree)).toContain('cloze-blank');
    // 原 Markdown 字符串未被修改
    expect(src).toBe('进程是**资源分配**的基本单位。');
  });

  it('中文、全角标点与特殊字符都能挖空', () => {
    const src = '《论语》曰：“学而时习之，不亦说乎？” C++ 与 C# 都是编程语言；路径 /etc/hosts 是文件。';
    const tree = parseMarkdown(src);
    const node = collectClozeNodes(tree)[0];
    for (const answer of ['学而时习之', 'C++', 'C#', '/etc/hosts', '《论语》', '“']) {
      const start = node.text.indexOf(answer);
      expect(start, answer).toBeGreaterThanOrEqual(0);
      const t = parseMarkdown(src);
      expect(() =>
        remarkCloze({ blanks: [{ id: 'x', nodeId: collectClozeNodes(t)[0].id, start, end: start + answer.length, length: answer.length }] })(t as never),
      ).not.toThrow();
    }
  });

  it('空挖空列表不改变 AST', () => {
    const tree = parseMarkdown('正文内容。');
    const before = JSON.stringify(tree);
    remarkCloze({ blanks: [] })(tree as never);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('生成给模型的文本会把图片替换为占位说明', () => {
    const src = '前文\n\n![进程状态图](img/a.png)\n\n后文 <img src="b.png" alt="示意">\n';
    const out = toAiText(src);
    expect(out).toContain('[图片：进程状态图（图片内容不可见）]');
    expect(out).not.toContain('img/a.png');
    expect(out).toContain('前文');
    expect(out).toContain('后文');
  });

  it('提取标题：优先一级标题，否则回退到文件名', () => {
    expect(extractTitle(parseMarkdown('# 进程管理\n\n正文'), '文件名')).toBe('进程管理');
    expect(extractTitle(parseMarkdown('## 二级标题\n'), '文件名')).toBe('文件名');
  });

  it('与前端使用同一套解析器（remark-parse + remark-gfm）时节点标识一致', () => {
    const src = '| a | b |\n| - | - |\n| 1 | 2 |\n\n~~删除~~ 与 [链接](x.md) 混排。';
    const p1 = unified().use(remarkParse).use(remarkGfm);
    const p2 = unified().use(remarkParse).use(remarkGfm);
    const ids1 = collectClozeNodes(p1.parse(src) as never).map((n) => n.id);
    const ids2 = collectClozeNodes(p2.parse(src) as never).map((n) => n.id);
    expect(ids1).toEqual(ids2);
    expect(ids1.length).toBeGreaterThan(0);
  });
});

describe('答案标准化与原文匹配', () => {
  it('忽略大小写、空白、全半角与标点差异', () => {
    expect(normalizeAnswer(' TCP ')).toBe('tcp');
    expect(normalizeAnswer('ＴＣＰ')).toBe('tcp');
    expect(normalizeAnswer('三次握手。')).toBe('三次握手');
    expect(normalizeAnswer('（就绪态）')).toBe('就绪态');
    expect(normalizeAnswer('...')).toBe('');
    expect(normalizeAnswer('资源 分配')).toBe('资源分配');
  });

  it('校验模型引用是否真的来自原文', () => {
    const article = '进程是操作系统进行资源分配的基本单位，线程是调度的基本单位。';
    expect(quoteAppearsIn('进程是操作系统进行资源分配的基本单位', article)).toBe(true);
    expect(quoteAppearsIn('进程是……基本单位', article)).toBe(true);
    expect(quoteAppearsIn('进程会直接访问磁盘', article)).toBe(false);
    expect(quoteAppearsIn('', article)).toBe(false);
  });
});

describe('路径解析与链接安全', () => {
  it('解析文档中的相对路径，支持上下级目录', () => {
    expect(resolveRelative('操作系统/进程管理.md', '内存管理.md')).toBe('操作系统/内存管理.md');
    expect(resolveRelative('操作系统/进程管理.md', '../计算机网络/TCP协议.md')).toBe('计算机网络/TCP协议.md');
    expect(resolveRelative('操作系统/进程管理.md', 'images/a.png')).toBe('操作系统/images/a.png');
    expect(resolveRelative('操作系统/进程管理.md', '/绝对路径.md')).toBe('绝对路径.md');
  });

  it('越出学习目录的路径返回 null', () => {
    expect(resolveRelative('顶层.md', '../secret.md')).toBeNull();
    expect(resolveRelative('a/b/c.md', '../../../../etc/passwd')).toBeNull();
  });

  it('识别并阻止不安全的协议', () => {
    expect(classifyUrl('https://example.com')).toBe('external');
    expect(classifyUrl('//example.com')).toBe('external');
    expect(classifyUrl('mailto:a@b.com')).toBe('external');
    expect(classifyUrl('#section')).toBe('anchor');
    expect(classifyUrl('images/a.png')).toBe('relative');
    expect(classifyUrl('javascript:alert(1)')).toBe('unsafe');
    expect(classifyUrl('JaVaScRiPt:alert(1)')).toBe('unsafe');
    expect(classifyUrl('data:text/html,<script>')).toBe('unsafe');
    expect(classifyUrl('vbscript:msgbox')).toBe('unsafe');
    expect(classifyUrl('file:///etc/passwd')).toBe('unsafe');
  });

  it('拆分链接中的 hash 片段', () => {
    expect(splitHash('a.md#标题')).toEqual({ path: 'a.md', hash: '标题' });
    expect(splitHash('a.md')).toEqual({ path: 'a.md', hash: '' });
    expect(splitHash('a.md?x=1#y')).toEqual({ path: 'a.md', hash: 'y' });
  });
});
