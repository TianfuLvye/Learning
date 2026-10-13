import path from 'node:path';
import fs from 'node:fs/promises';
import { HttpError } from './errors';

/**
 * 将用户提供的相对路径解析为 root 内的绝对路径。
 * 拒绝：绝对路径、NUL 字符、越出根目录的 ..、隐藏文件/目录（如 .progress.json）、符号链接逃逸。
 */
export async function resolveInside(root: string, rel: unknown, opts: { mustExist?: boolean } = {}): Promise<{ abs: string; rel: string }> {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) {
    throw new HttpError(400, 'bad_path', '路径无效');
  }
  if (rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.includes('\\')) {
    throw new HttpError(400, 'bad_path', '路径无效');
  }
  const normalized = path.posix.normalize(rel);
  const segments = normalized.split('/');
  if (normalized.startsWith('..') || segments.some((s) => s === '..')) {
    throw new HttpError(403, 'forbidden_path', '禁止访问学习目录之外的文件');
  }
  if (segments.some((s) => s.startsWith('.'))) {
    throw new HttpError(403, 'forbidden_path', '禁止访问隐藏文件');
  }
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, normalized);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new HttpError(403, 'forbidden_path', '禁止访问学习目录之外的文件');
  }
  if (opts.mustExist !== false) {
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      throw new HttpError(404, 'not_found', '文件不存在');
    }
    const realRoot = await fs.realpath(rootAbs);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new HttpError(403, 'forbidden_path', '禁止访问学习目录之外的文件');
    }
  }
  return { abs, rel: normalized };
}
