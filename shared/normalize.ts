// 答案标准化与原文匹配工具

const PUNCT_RE = /[\s　.,;:!?'"`~·、，。；：！？“”‘’（）()【】\[\]{}《》<>〈〉「」『』\-—_–…/\\|]+/g;

/**
 * 填空答案标准化：
 * - NFKC：全角转半角、兼容字符统一
 * - 忽略大小写
 * - 忽略空白与常见中英文标点
 */
export function normalizeAnswer(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(PUNCT_RE, '').trim();
}

/** 用于在原文中查找引用文本：折叠空白、去掉 Markdown 强调符号 */
export function normalizeForMatch(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[*_`~>#]/g, '')
    .replace(/[\s　]+/g, '')
    .replace(/[“”"「」『』'‘’]/g, '');
}

/** 判断模型给出的引用是否出现在原文中（允许省略号分段引用） */
export function quoteAppearsIn(quote: string, haystackNormalized: string): boolean {
  const parts = quote
    .split(/\.{3,}|…+/)
    .map((p) => normalizeForMatch(p))
    .filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  return parts.every((p) => haystackNormalized.includes(p));
}

/** 返回 value 中第 n 次（从 1 开始，非重叠）出现 needle 的位置，不存在返回 -1 */
export function indexOfOccurrence(value: string, needle: string, n: number): number {
  if (!needle || n < 1) return -1;
  let from = 0;
  for (let i = 1; ; i++) {
    const idx = value.indexOf(needle, from);
    if (idx < 0) return -1;
    if (i === n) return idx;
    from = idx + needle.length;
  }
}

export function countOccurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = value.indexOf(needle, from);
    if (idx < 0) return count;
    count++;
    from = idx + needle.length;
  }
}
