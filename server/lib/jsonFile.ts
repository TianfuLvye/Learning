import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 原子写入：先写入同目录临时文件并 fsync，再 rename 覆盖目标文件。
 * rename 在同一文件系统上是原子的，进程中断时目标文件要么是旧内容，要么是新内容。
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** 读取 JSON 文件；文件损坏时备份为 .corrupt-<时间戳> 并返回 null，避免覆盖用户数据 */
export async function readJsonSafe<T>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    await fs.copyFile(file, backup).catch(() => undefined);
    console.warn(`[store] ${file} 内容损坏，已备份到 ${backup}`);
    return null;
  }
}

/** 串行化同一文件的读改写，避免并发请求互相覆盖 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
