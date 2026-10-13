// 练习缓存：键 = 练习类型 + 文档路径 + 文档内容哈希 + 提示词版本 + 模型配置
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ExerciseMeta } from '../../shared/types';
import { writeFileAtomic } from '../lib/jsonFile';
import type { ClozeBlankFull, McqQuestionFull, QaQuestionFull } from './schemas';

export type StoredMeta = Omit<ExerciseMeta, 'fromCache'>;
export type StoredExercise =
  | (StoredMeta & { type: 'mcq'; questions: McqQuestionFull[] })
  | (StoredMeta & { type: 'cloze'; blanks: ClozeBlankFull[] })
  | (StoredMeta & { type: 'qa'; questions: QaQuestionFull[] });

export function cacheKey(parts: { type: string; path: string; docHash: string; promptVersion: string; modelSignature: string }): string {
  return crypto
    .createHash('sha256')
    .update([parts.type, parts.path, parts.docHash, parts.promptVersion, parts.modelSignature].join('\n'))
    .digest('hex')
    .slice(0, 32);
}

export class ExerciseStore {
  constructor(private dir: string) {}

  private setFile(setId: string) {
    if (!/^[a-f0-9-]{8,64}$/i.test(setId)) return null;
    return path.join(this.dir, 'sets', `${setId}.json`);
  }

  private indexFile(key: string) {
    return path.join(this.dir, 'index', `${key}.json`);
  }

  async getSet(setId: string): Promise<StoredExercise | null> {
    const file = this.setFile(setId);
    if (!file) return null;
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as StoredExercise;
    } catch {
      return null;
    }
  }

  async getByKey(key: string): Promise<StoredExercise | null> {
    try {
      const { setId } = JSON.parse(await fs.readFile(this.indexFile(key), 'utf8')) as { setId: string };
      return await this.getSet(setId);
    } catch {
      return null;
    }
  }

  async save(key: string, set: StoredExercise): Promise<void> {
    const file = this.setFile(set.setId);
    if (!file) throw new Error('invalid set id');
    await writeFileAtomic(file, JSON.stringify(set));
    await writeFileAtomic(this.indexFile(key), JSON.stringify({ setId: set.setId, createdAt: set.createdAt }));
  }
}
