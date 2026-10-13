import { describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeApp } from './helpers';

describe('目录树与阅读', () => {
  it('展示多级目录、递归统计进度，只统计 Markdown 文档', async () => {
    const { ctx, dir, learnDir, cleanup } = await makeApp({
      files: {
        '操作系统/进程管理.md': '# 进程管理\n\n进程是资源分配的基本单位。',
        '操作系统/内存管理.md': '# 内存管理\n\n虚拟内存基于局部性原理。',
        '操作系统/笔记/深入.md': '# 深入\n\n正文内容。',
        '计算机网络/TCP协议.md': '# TCP\n\n三次握手建立连接。',
        'README.txt': '不是 Markdown，不应计入统计',
      },
    });
    try {
      await fs.writeFile(path.join(learnDir, '操作系统', 'images.png'), 'not-an-image');
      const res = await request(ctx.app).get('/api/tree').expect(200);
      const root = res.body.root as { children: Array<{ name: string; children?: Array<{ name: string }>; stats: { total: number; completed: number } }> };
      const names = root.children.map((c) => c.name).sort();
      expect(names).toEqual(['操作系统', '计算机网络']);

      const os = root.children.find((c) => c.name === '操作系统') as unknown as {
        stats: { total: number; completed: number };
        children: Array<{ name: string }>;
      };
      expect(os.stats.total).toBe(3); // 递归包含 笔记/深入.md
      expect(os.stats.completed).toBe(0);
      expect(os.children.map((c) => c.name)).toContain('笔记');

      await request(ctx.app).put('/api/progress').send({ path: '操作系统/进程管理.md', status: 'completed' }).expect(200);
      const res2 = await request(ctx.app).get('/api/tree').expect(200);
      expect(res2.body.root.stats.total).toBe(4);
      expect(res2.body.root.stats.completed).toBe(1);
      const os2 = res2.body.root.children.find((c: { name: string }) => c.name === '操作系统') as { stats: { completed: number } };
      expect(os2.stats.completed).toBe(1); // 子目录完成数向上汇总

      // 进度文件本身不应被计入
      expect(await fs.readFile(path.join(learnDir, '.progress.json'), 'utf8')).toContain('操作系统/进程管理.md');
    } finally {
      await cleanup();
      void dir;
    }
  });

  it('首次阅读自动进入学习中，进度可持久化到磁盘', async () => {
    const { ctx, learnDir, cleanup } = await makeApp();
    try {
      const open = await request(ctx.app).post('/api/progress/open').send({ path: '操作系统/进程管理.md' }).expect(200);
      expect(open.body.status).toBe('in_progress');
      const tree = await request(ctx.app).get('/api/tree').expect(200);
      expect(tree.body.root.stats.inProgress).toBe(1);

      // 手动标记完成后再打开，不应被降级
      await request(ctx.app).put('/api/progress').send({ path: '操作系统/进程管理.md', status: 'completed' }).expect(200);
      await request(ctx.app).post('/api/progress/open').send({ path: '操作系统/进程管理.md' }).expect(200);
      const tree2 = await request(ctx.app).get('/api/tree').expect(200);
      expect(tree2.body.root.stats.completed).toBe(1);

      // 重新学习：回到学习中，成绩记录不受影响
      await request(ctx.app).put('/api/progress').send({ path: '操作系统/进程管理.md', status: 'in_progress' }).expect(200);
      const saved = JSON.parse(await fs.readFile(path.join(learnDir, '.progress.json'), 'utf8'));
      expect(saved.files['操作系统/进程管理.md'].status).toBe('in_progress');
    } finally {
      await cleanup();
    }
  });

  it('文件被移动后按内容哈希迁移进度', async () => {
    const { ctx, learnDir, cleanup } = await makeApp();
    try {
      await request(ctx.app).put('/api/progress').send({ path: '操作系统/进程管理.md', status: 'completed' }).expect(200);
      const src = path.join(learnDir, '操作系统', '进程管理.md');
      const dst = path.join(learnDir, '操作系统', '进程与线程.md');
      await fs.rename(src, dst);
      const res = await request(ctx.app).get('/api/tree').expect(200);
      const flat = JSON.stringify(res.body.root);
      expect(flat).toContain('进程与线程.md');
      expect(res.body.root.stats.completed).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('删除文件后进度统计忽略旧记录', async () => {
    const { ctx, learnDir, cleanup } = await makeApp();
    try {
      await request(ctx.app).put('/api/progress').send({ path: '操作系统/进程管理.md', status: 'completed' }).expect(200);
      await fs.rm(path.join(learnDir, '操作系统', '进程管理.md'));
      const res = await request(ctx.app).get('/api/tree').expect(200);
      expect(res.body.root.stats.total).toBe(0);
      expect(res.body.root.stats.completed).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('读取文档返回标题、内容与内容哈希', async () => {
    const { ctx, cleanup } = await makeApp();
    try {
      const res = await request(ctx.app).get('/api/doc').query({ path: '操作系统/进程管理.md' }).expect(200);
      expect(res.body.title).toBe('进程管理');
      expect(res.body.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(res.body.content).toContain('资源分配');
    } finally {
      await cleanup();
    }
  });
});

describe('安全限制', () => {
  it('阻止越出 learn/ 的路径访问', async () => {
    const { ctx, cleanup } = await makeApp();
    try {
      for (const p of ['../.env', '../../etc/passwd', '/etc/passwd', '操作系统/../../secrets.md', 'C:\\windows\\system32']) {
        const res = await request(ctx.app).get('/api/doc').query({ path: p });
        expect(res.status, p).toBeGreaterThanOrEqual(400);
      }
      await request(ctx.app).get('/api/asset').query({ path: '../.env' }).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
      await request(ctx.app).get('/api/doc').query({ path: '.progress.json' }).expect(403);
    } finally {
      await cleanup();
    }
  });

  it('资源接口只返回白名单内的文件类型', async () => {
    const { ctx, learnDir, cleanup } = await makeApp();
    try {
      await fs.writeFile(path.join(learnDir, '操作系统', 'secret.env'), 'API_KEY=1');
      const res = await request(ctx.app).get('/api/asset').query({ path: '操作系统/secret.env' });
      expect(res.status).toBe(415);
    } finally {
      await cleanup();
    }
  });

  it('符号链接指向学习目录之外时被拒绝', async () => {
    const { ctx, learnDir, dir, cleanup } = await makeApp();
    try {
      const outside = path.join(dir, 'outside.md');
      await fs.writeFile(outside, '# 外部文件');
      await fs.symlink(outside, path.join(learnDir, '操作系统', 'link.md'));
      const res = await request(ctx.app).get('/api/doc').query({ path: '操作系统/link.md' });
      expect(res.status).toBe(403);
    } finally {
      await cleanup();
    }
  });

  it('未配置 API Key 时 AI 接口返回可读的配置提示', async () => {
    const { ctx, cleanup } = await makeApp({ aiKey: '' });
    try {
      const cfg = await request(ctx.app).get('/api/config').expect(200);
      expect(cfg.body.aiConfigured).toBe(false);
      const res = await request(ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(503);
      expect(res.body.error.code).toBe('not_configured');
      expect(res.body.error.message).toContain('DEEPSEEK_API_KEY');
      // 阅读与进度仍然可用
      await request(ctx.app).get('/api/doc').query({ path: '操作系统/进程管理.md' }).expect(200);
      await request(ctx.app).post('/api/progress/open').send({ path: '操作系统/进程管理.md' }).expect(200);
    } finally {
      await cleanup();
    }
  });

  it('拒绝非法参数', async () => {
    const { ctx, cleanup } = await makeApp();
    try {
      await request(ctx.app).put('/api/progress').send({ path: '操作系统/进程管理.md', status: 'done' }).expect(400);
      await request(ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'x' }).expect(400);
      await request(ctx.app).get('/api/exercises').query({ path: '操作系统/进程管理.md', type: 'x' }).expect(400);
      await request(ctx.app).post('/api/exercises/not-a-set/grade').send({ type: 'mcq', answers: {} }).expect(404);
      await request(ctx.app).get('/api/unknown').expect(404);
    } finally {
      await cleanup();
    }
  });
});
