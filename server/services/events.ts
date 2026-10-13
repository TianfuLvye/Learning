import path from 'node:path';
import type { Response } from 'express';
import chokidar, { type FSWatcher } from 'chokidar';
import { isMarkdownPath } from '../../shared/paths';

export type LibraryEvent = { type: 'tree' } | { type: 'doc'; path: string } | { type: 'progress' };

/** 通过 SSE 将 learn/ 的变更推送给前端 */
export class EventHub {
  private clients = new Set<Response>();
  private watcher: FSWatcher | null = null;
  private treeTimer: NodeJS.Timeout | null = null;
  private docTimers = new Map<string, NodeJS.Timeout>();

  attach(res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    res.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  emit(evt: LibraryEvent) {
    const payload = `data: ${JSON.stringify(evt)}\n\n`;
    for (const c of this.clients) c.write(payload);
  }

  private scheduleTree() {
    if (this.treeTimer) clearTimeout(this.treeTimer);
    this.treeTimer = setTimeout(() => this.emit({ type: 'tree' }), 250);
  }

  watch(learnDir: string) {
    this.watcher = chokidar.watch(learnDir, {
      ignoreInitial: true,
      ignored: (p: string) => {
        const rel = path.relative(learnDir, p);
        return rel !== '' && rel.split(path.sep).some((s) => s.startsWith('.') || s === 'node_modules');
      },
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.watcher.on('all', (event, p) => {
      const rel = path.relative(learnDir, p).split(path.sep).join('/');
      if (event === 'addDir' || event === 'unlinkDir' || ((event === 'add' || event === 'unlink') && isMarkdownPath(rel))) {
        this.scheduleTree();
      }
      if ((event === 'change' || event === 'add') && isMarkdownPath(rel)) {
        clearTimeout(this.docTimers.get(rel));
        this.docTimers.set(rel, setTimeout(() => this.emit({ type: 'doc', path: rel }), 200));
      }
    });
    this.watcher.on('error', (err) => console.warn('[watch]', err));
  }

  async close() {
    await this.watcher?.close();
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}
