import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp, type AppContext } from '../server/app';
import { loadConfig } from '../server/config';

export const SAMPLE = `# 进程管理

进程是操作系统进行**资源分配**的基本单位。进程与进程之间相互独立，每个进程都有自己独立的地址空间。

## 进程的状态

进程在生命周期中有三种基本状态：就绪态、运行态和阻塞态。阻塞态不能直接转换为运行态，必须先进入就绪态。

| 状态 | 含义 |
| --- | --- |
| 就绪态 | 等待 CPU |
| 运行态 | 正在执行 |

\`\`\`c
int pid = fork(); // 进程不会挖空代码
\`\`\`

> 进程与进程的调度由操作系统负责。
`;

/** 在临时目录中搭建完整的应用实例，供测试使用 */
export async function makeApp(opts: { files?: Record<string, string>; aiKey?: string; baseUrl?: string } = {}): Promise<{
  ctx: AppContext;
  dir: string;
  learnDir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdlearn-test-'));
  const learnDir = path.join(dir, 'learn');
  const promptsDir = path.join(dir, 'prompts');
  await fs.mkdir(path.join(learnDir, '操作系统'), { recursive: true });
  await fs.mkdir(promptsDir, { recursive: true });
  const files = opts.files ?? { '操作系统/进程管理.md': SAMPLE };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(learnDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  const promptNames = ['mcq', 'cloze', 'qa_generate', 'qa_evaluate'];
  for (const name of promptNames) {
    const src = path.join(process.cwd(), 'prompts', `${name}.md`);
    await fs.copyFile(src, path.join(promptsDir, `${name}.md`));
  }
  const config = loadConfig({
    learnDir,
    promptsDir,
    cacheDir: path.join(dir, '.cache'),
    synonymsFile: path.join(process.cwd(), 'config', 'synonyms.json'),
    staticDir: null,
    ai: {
      apiKey: 'test-key',
      baseUrl: opts.baseUrl ?? 'http://127.0.0.1:1',
      model: 'deepseek-chat',
      timeoutMs: 3000,
      maxRetries: 0,
      maxTokens: 2000,
      temperature: 0,
      ...(opts.aiKey !== undefined ? { apiKey: opts.aiKey } : {}),
    },
  });
  const ctx = createApp(config);
  return {
    ctx,
    dir,
    learnDir,
    cleanup: async () => {
      await ctx.events.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
