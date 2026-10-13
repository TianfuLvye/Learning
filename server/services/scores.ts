import path from 'node:path';
import type { DocScores, ExerciseType } from '../../shared/types';
import { readJsonSafe, SerialQueue, writeFileAtomic } from '../lib/jsonFile';

interface ScoresData {
  version: 1;
  files: Record<string, DocScores>;
}

const HISTORY_LIMIT = 30;

/** 练习成绩：与学习状态分开保存在 learn/.scores.json，重新答题不会影响完成标记 */
export class ScoreStore {
  readonly file: string;
  private queue = new SerialQueue();

  constructor(learnDir: string) {
    this.file = path.join(learnDir, '.scores.json');
  }

  private async load(): Promise<ScoresData> {
    const raw = await readJsonSafe<ScoresData>(this.file);
    if (raw && typeof raw === 'object' && raw.files && typeof raw.files === 'object') return { version: 1, files: raw.files };
    return { version: 1, files: {} };
  }

  async get(rel: string): Promise<DocScores> {
    const data = await this.queue.run(() => this.load());
    return data.files[rel] ?? { history: [] };
  }

  async record(rel: string, type: ExerciseType, setId: string, score: number, total: number, questionId?: string): Promise<void> {
    await this.queue.run(async () => {
      const data = await this.load();
      const doc: DocScores = data.files[rel] ?? { history: [] };
      const at = new Date().toISOString();
      if (type === 'qa' && questionId) {
        doc.qa = { ...(doc.qa ?? {}), [questionId]: { setId, score, at } };
      } else if (type === 'mcq' || type === 'cloze') {
        doc[type] = { setId, score, total, at };
      }
      doc.history = [...(doc.history ?? []), { type, setId, score, total, at }].slice(-HISTORY_LIMIT);
      data.files[rel] = doc;
      await writeFileAtomic(this.file, JSON.stringify(data, null, 2) + '\n');
    });
  }
}
