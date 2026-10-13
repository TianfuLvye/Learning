import path from 'node:path';
import fs from 'node:fs/promises';
import type { LearnStatus } from '../../shared/types';
import { readJsonSafe, SerialQueue, writeFileAtomic } from '../lib/jsonFile';

export interface ProgressEntry {
  status: LearnStatus;
  updatedAt: string;
  firstOpenedAt?: string;
  completedAt?: string;
  /** 内容哈希，用于识别被移动/重命名的文件并迁移进度 */
  hash?: string;
}

interface ProgressData {
  version: 1;
  files: Record<string, ProgressEntry>;
}

const STATUSES: LearnStatus[] = ['not_started', 'in_progress', 'completed'];

export function isLearnStatus(v: unknown): v is LearnStatus {
  return typeof v === 'string' && (STATUSES as string[]).includes(v);
}

/** 学习状态存储：learn/.progress.json，键为相对 learn/ 的路径 */
export class ProgressStore {
  readonly file: string;
  private queue = new SerialQueue();
  private cache: { mtimeMs: number; data: ProgressData } | null = null;

  constructor(learnDir: string) {
    this.file = path.join(learnDir, '.progress.json');
  }

  private async load(): Promise<ProgressData> {
    let mtimeMs = -1;
    try {
      mtimeMs = (await fs.stat(this.file)).mtimeMs;
    } catch {
      /* 文件不存在 */
    }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.data;
    const raw = mtimeMs >= 0 ? await readJsonSafe<Partial<ProgressData>>(this.file) : null;
    const data: ProgressData = { version: 1, files: {} };
    if (raw && typeof raw === 'object' && raw.files && typeof raw.files === 'object') {
      for (const [k, v] of Object.entries(raw.files)) {
        if (v && isLearnStatus((v as ProgressEntry).status)) data.files[k] = v as ProgressEntry;
      }
    }
    this.cache = { mtimeMs, data };
    return data;
  }

  private async save(data: ProgressData): Promise<void> {
    await writeFileAtomic(this.file, JSON.stringify(data, null, 2) + '\n');
    const st = await fs.stat(this.file);
    this.cache = { mtimeMs: st.mtimeMs, data };
  }

  async all(): Promise<Record<string, ProgressEntry>> {
    return (await this.queue.run(() => this.load())).files;
  }

  async statusOf(rel: string): Promise<LearnStatus> {
    return (await this.all())[rel]?.status ?? 'not_started';
  }

  /** 首次阅读：未开始 → 学习中；已有状态保持不变 */
  async markOpened(rel: string, hash?: string): Promise<LearnStatus> {
    return this.queue.run(async () => {
      const data = await this.load();
      const now = new Date().toISOString();
      const cur = data.files[rel];
      if (cur && cur.status !== 'not_started') {
        if (hash && cur.hash !== hash) {
          cur.hash = hash;
          await this.save(data);
        }
        return cur.status;
      }
      data.files[rel] = { ...cur, status: 'in_progress', updatedAt: now, firstOpenedAt: cur?.firstOpenedAt ?? now, hash };
      await this.save(data);
      return 'in_progress';
    });
  }

  async setStatus(rel: string, status: LearnStatus, hash?: string): Promise<ProgressEntry> {
    return this.queue.run(async () => {
      const data = await this.load();
      const now = new Date().toISOString();
      const cur = data.files[rel];
      const next: ProgressEntry = {
        ...cur,
        status,
        updatedAt: now,
        hash: hash ?? cur?.hash,
        firstOpenedAt: cur?.firstOpenedAt ?? (status !== 'not_started' ? now : undefined),
        completedAt: status === 'completed' ? now : undefined,
      };
      data.files[rel] = next;
      await this.save(data);
      return next;
    });
  }

  /**
   * 文件移动/重命名后的进度迁移：旧路径已不存在、新路径尚无记录，且内容哈希一致时迁移。
   * 不匹配的旧记录保留在文件中，但不参与统计。
   */
  async migrateMoved(existing: Set<string>, hashOf: (rel: string) => Promise<string | null>): Promise<number> {
    return this.queue.run(async () => {
      const data = await this.load();
      const orphans = Object.entries(data.files).filter(([k, v]) => !existing.has(k) && v.hash);
      if (orphans.length === 0) return 0;
      const fresh = [...existing].filter((p) => !data.files[p]);
      if (fresh.length === 0) return 0;
      const byHash = new Map<string, string>();
      for (const [k, v] of orphans) byHash.set(v.hash!, k);
      let moved = 0;
      for (const p of fresh) {
        const h = await hashOf(p);
        const old = h ? byHash.get(h) : undefined;
        if (old && data.files[old]) {
          data.files[p] = data.files[old];
          delete data.files[old];
          byHash.delete(h!);
          moved++;
        }
      }
      if (moved > 0) await this.save(data);
      return moved;
    });
  }
}
