// 前端使用的相对路径解析（POSIX 风格，基于 learn/ 根目录）

/** 解析 base 文档目录下的相对路径，越出 learn/ 根目录时返回 null */
export function resolveRelative(docPath: string, target: string): string | null {
  const baseParts = docPath.split('/').slice(0, -1);
  const parts = target.startsWith('/') ? [] : [...baseParts];
  for (const seg of target.replace(/^\/+/, '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

export function isExternalUrl(url: string): boolean {
  return /^(https?:)?\/\//i.test(url);
}

const SAFE_PROTOCOLS = /^(https?|mailto|tel):/i;

/** 判断是否为带协议的 URL，以及该协议是否安全 */
export function classifyUrl(url: string): 'external' | 'anchor' | 'relative' | 'unsafe' {
  const trimmed = url.trim();
  if (trimmed.startsWith('#')) return 'anchor';
  if (trimmed.startsWith('//')) return 'external';
  const proto = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (proto) return SAFE_PROTOCOLS.test(trimmed) ? 'external' : 'unsafe';
  return 'relative';
}

export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

export function splitHash(url: string): { path: string; hash: string } {
  const i = url.indexOf('#');
  const q = url.indexOf('?');
  let end = url.length;
  if (q >= 0) end = Math.min(end, q);
  if (i >= 0) end = Math.min(end, i);
  return { path: url.slice(0, end), hash: i >= 0 ? url.slice(i + 1) : '' };
}

export function safeDecode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}
