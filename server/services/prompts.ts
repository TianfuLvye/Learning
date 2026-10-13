import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../lib/errors';

export type PromptName = 'mcq' | 'cloze' | 'qa_generate' | 'qa_evaluate';

export interface LoadedPrompt {
  name: PromptName;
  system: string;
  user: string;
  /** 提示词内容哈希，作为缓存键中的“提示词版本” */
  version: string;
}

const DEFAULT_SYSTEM = '你是一名严谨的教学助手。只依据用户提供的文章内容工作，并严格输出 JSON。';

/**
 * 提示词文件格式：
 *   <!-- system --> 之后为系统提示词
 *   <!-- user -->   之后为用户提示词模板
 * 模板变量写作 {{变量名}}。每次请求都会重新读取文件，修改后立即生效。
 */
export function parsePromptFile(name: PromptName, raw: string): LoadedPrompt {
  const version = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const sysMatch = /<!--\s*system\s*-->/i.exec(raw);
  const userMatch = /<!--\s*user\s*-->/i.exec(raw);
  let system = DEFAULT_SYSTEM;
  let user = raw;
  if (userMatch) {
    user = raw.slice(userMatch.index + userMatch[0].length);
    if (sysMatch && sysMatch.index < userMatch.index) {
      system = raw.slice(sysMatch.index + sysMatch[0].length, userMatch.index);
    }
  }
  return { name, system: system.trim(), user: user.trim(), version };
}

export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m,
  );
}

export class PromptLoader {
  constructor(private dir: string) {}

  async load(name: PromptName): Promise<LoadedPrompt> {
    const file = path.join(this.dir, `${name}.md`);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      throw new HttpError(500, 'prompt_missing', `提示词文件缺失：prompts/${name}.md`);
    }
    const prompt = parsePromptFile(name, raw);
    if (!prompt.user) throw new HttpError(500, 'prompt_empty', `提示词文件为空：prompts/${name}.md`);
    return prompt;
  }
}
