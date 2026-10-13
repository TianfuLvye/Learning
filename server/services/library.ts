import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DirStats, DocResponse, LearnStatus, TreeDirNode, TreeNode, TreeResponse } from '../../shared/types';
import { extractTitle, parseMarkdown } from '../../shared/markdown';
import { isMarkdownPath } from '../../shared/paths';
import { resolveInside } from '../lib/safePath';
import { HttpError } from '../lib/errors';
import type { ProgressStore } from './progress';

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 32;

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isHidden(name: string) {
  return name.startsWith('.') || name === 'node_modules';
}

/** 递归扫描 learn/，只收录 Markdown 文件；不含 Markdown 的目录不显示 */
async function scanDir(abs: string, rel: string, depth: number, files: string[]): Promise<TreeDirNode> {
  const node: TreeDirNode = {
    type: 'dir',
    name: rel ? path.posix.basename(rel) : 'learn',
    path: rel,
    stats: { total: 0, completed: 0, inProgress: 0 },
    children: [],
  };
  if (depth > MAX_DEPTH) return node;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return node;
  }
  const dirs: TreeNode[] = [];
  const mdFiles: TreeNode[] = [];
  for (const e of entries) {
    if (isHidden(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const childAbs = path.join(abs, e.name);
    if (e.isDirectory()) {
      const sub = await scanDir(childAbs, childRel, depth + 1, files);
      if (sub.children.length > 0) dirs.push(sub);
    } else if (e.isFile() && isMarkdownPath(e.name)) {
      files.push(childRel);
      mdFiles.push({ type: 'file', name: e.name, path: childRel, status: 'not_started' });
    }
  }
  dirs.sort((a, b) => collator.compare(a.name, b.name));
  mdFiles.sort((a, b) => collator.compare(a.name, b.name));
  node.children = [...dirs, ...mdFiles];
  return node;
}

/** 递归计算目录统计：当前目录及全部子目录中的文档数、已完成数 */
function applyStatus(node: TreeDirNode, statusOf: (p: string) => LearnStatus): DirStats {
  const stats: DirStats = { total: 0, completed: 0, inProgress: 0 };
  for (const child of node.children) {
    if (child.type === 'file') {
      child.status = statusOf(child.path);
      stats.total++;
      if (child.status === 'completed') stats.completed++;
      else if (child.status === 'in_progress') stats.inProgress++;
    } else {
      const s = applyStatus(child, statusOf);
      stats.total += s.total;
      stats.completed += s.completed;
      stats.inProgress += s.inProgress;
    }
  }
  node.stats = stats;
  return stats;
}

export class Library {
  constructor(
    readonly learnDir: string,
    private progress: ProgressStore,
  ) {}

  async tree(): Promise<TreeResponse> {
    await fs.mkdir(this.learnDir, { recursive: true });
    const files: string[] = [];
    let root = await scanDir(this.learnDir, '', 0, files);
    const existing = new Set(files);
    const moved = await this.progress.migrateMoved(existing, async (rel) => {
      try {
        return sha256(await fs.readFile(path.join(this.learnDir, rel), 'utf8'));
      } catch {
        return null;
      }
    });
    if (moved > 0) root = await scanDir(this.learnDir, '', 0, []);
    const progress = await this.progress.all();
    // 只统计当前存在的 Markdown 文件；不存在的旧记录不参与统计
    const stats = applyStatus(root, (p) => progress[p]?.status ?? 'not_started');
    return { root, stats };
  }

  async readDoc(relInput: unknown): Promise<DocResponse> {
    const { abs, rel } = await resolveInside(this.learnDir, relInput);
    if (!isMarkdownPath(rel)) throw new HttpError(400, 'not_markdown', '只能打开 Markdown 文档');
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new HttpError(404, 'not_found', '文件不存在');
    if (st.size > MAX_DOC_BYTES) throw new HttpError(413, 'too_large', '文档过大（超过 2MB）');
    const content = (await fs.readFile(abs, 'utf8')).replace(/^﻿/, '');
    const title = extractTitle(parseMarkdown(content), path.posix.basename(rel).replace(/\.(md|markdown)$/i, ''));
    return {
      path: rel,
      title,
      content,
      hash: sha256(content),
      mtime: st.mtimeMs,
      status: await this.progress.statusOf(rel),
    };
  }
}
