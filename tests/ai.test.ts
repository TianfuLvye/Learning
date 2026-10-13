import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import http from 'node:http';
import { makeApp } from './helpers';
import { extractJson, AiError } from '../server/ai/deepseek';

// ---------------- 可编程的假 DeepSeek 服务 ----------------
type Reply = { status?: number; body?: unknown; raw?: string; delayMs?: number; connectionDrop?: boolean };

class FakeDeepSeek {
  server: http.Server;
  url = '';
  replies: Reply[] = [];
  calls: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          this.calls.push(JSON.parse(body));
        } catch {
          this.calls.push({ model: '', messages: [] });
        }
        const reply = this.replies.length > 1 ? this.replies.shift()! : this.replies[0] ?? { status: 500 };
        const send = () => {
          if (reply.connectionDrop) {
            res.destroy();
            return;
          }
          if (reply.status && reply.status >= 400) {
            res.writeHead(reply.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(reply.body ?? { error: { message: 'boom' } }));
            return;
          }
          const content = reply.raw ?? JSON.stringify(reply.body ?? {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: reply.status === 206 ? 'length' : 'stop' }],
            }),
          );
        };
        if (reply.delayMs) setTimeout(send, reply.delayMs);
        else send();
      });
    });
  }

  async listen() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    return this.url;
  }

  async close() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const goodMcq = {
  questions: [
    {
      id: '1',
      type: 'single',
      stem: '进程是操作系统的什么？',
      options: [
        { id: 'A', text: '资源分配的基本单位', isCorrect: true, explanation: '原文如此表述' },
        { id: 'B', text: '程序本身', isCorrect: false, explanation: '程序是静态的' },
        { id: 'C', text: '一段汇编代码', isCorrect: false, explanation: '理解过窄' },
        { id: 'D', text: '一种外设', isCorrect: false, explanation: '与原文无关' },
      ],
      correctOptionIds: ['A'],
      explanation: '考查进程的定义。',
      knowledgePoint: '进程定义',
      source: { quote: '进程是操作系统进行资源分配的基本单位', section: '概述' },
    },
  ],
};

describe('DeepSeek 集成', () => {
  let fake: FakeDeepSeek;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    fake = new FakeDeepSeek();
    await fake.listen();
  });

  afterAll(async () => {
    await fake.close();
    for (const c of cleanups) await c();
  });

  async function appWith(reply: Reply, opts: { maxRetries?: number; timeoutMs?: number } = {}) {
    fake.replies = [reply];
    fake.calls = [];
    const app = await makeApp({ baseUrl: fake.url });
    // 通过直接替换配置实现重试/超时参数控制
    if (opts.maxRetries !== undefined || opts.timeoutMs !== undefined) {
      const cfg = (app.ctx.services.ai as unknown as { config: { maxRetries: number; timeoutMs: number } }).config;
      if (opts.maxRetries !== undefined) cfg.maxRetries = opts.maxRetries;
      if (opts.timeoutMs !== undefined) cfg.timeoutMs = opts.timeoutMs;
    }
    cleanups.push(app.cleanup);
    return app;
  }

  it('正常生成选择题：只下发公开字段，答案保存在服务端', async () => {
    const app = await appWith({ body: goodMcq });
    const res = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(200);
    const ex = res.body.exercise;
    expect(ex.questions).toHaveLength(1);
    expect(ex.questions[0].options.map((o: { id: string }) => o.id)).toEqual(['A', 'B', 'C', 'D']);
    // 提交前不得泄露答案与解释
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('isCorrect');
    expect(json).not.toContain('原文如此表述');
    expect(json).not.toContain('correctOptionIds');
    // 请求体应符合 OpenAI 兼容格式并带 json 模式
    expect(fake.calls[0].model).toBe('deepseek-chat');
    expect(fake.calls[0].messages[0].role).toBe('system');
  });

  it('判分在服务端进行，返回答案解析、得分与原文依据校验结果', async () => {
    const app = await appWith({ body: goodMcq });
    const gen = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(200);
    const setId = gen.body.exercise.setId;

    const wrong = await request(app.ctx.app).post(`/api/exercises/${setId}/grade`).send({ type: 'mcq', answers: { q1: ['B'] } }).expect(200);
    expect(wrong.body.result.score).toBe(0);
    expect(wrong.body.result.questions[0].correctOptionIds).toEqual(['A']);
    expect(wrong.body.result.questions[0].options.find((o: { id: string }) => o.id === 'A').isCorrect).toBe(true);
    expect(wrong.body.result.questions[0].source.verified).toBe(true);

    const right = await request(app.ctx.app).post(`/api/exercises/${setId}/grade`).send({ type: 'mcq', answers: { q1: ['A'] } }).expect(200);
    expect(right.body.result.score).toBe(1);
  });

  it('丢弃选项与正确答案矛盾的题目；空结果触发重试后失败', async () => {
    const inconsistent = {
      questions: [
        { ...goodMcq.questions[0], correctOptionIds: ['A', 'B'] }, // 与 isCorrect 不一致
      ],
    };
    const app = await appWith({ body: inconsistent }, { maxRetries: 1 });
    const res = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(502);
    expect(res.body.error.code).toBe('invalid_content');
    expect(fake.calls.length).toBe(2); // 首次 + 1 次重试
  });

  it('多选题中只有一个正确答案时自动修正为单选', async () => {
    const fixed = {
      questions: [{ ...goodMcq.questions[0], type: 'multiple' }],
    };
    const app = await appWith({ body: fixed });
    const res = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(200);
    expect(res.body.exercise.questions[0].type).toBe('single');
    expect(res.body.exercise.warnings.join()).toContain('多选');
  });

  it('挖空题：校验节点、逐字匹配与重复词定位', async () => {
    const app = await appWith({ body: { blanks: [] } });
    // 先取到节点列表，构造真实的挖空响应
    const first = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'cloze' });
    const prompt = fake.calls.at(-1)!.messages.map((m) => m.content).join('\n');
    const nodes = [...prompt.matchAll(/"id":\s*"(t\d+)",\s*"text":\s*"((?:[^"\\]|\\.)*)"/g)];
    expect(nodes.length, '提示词中应包含带标识的文本节点').toBeGreaterThan(1);
    const nodeId = nodes[0][1];
    const answer = (JSON.parse(`"${nodes[0][2]}"`) as string).slice(0, 2);
    const nodeId2 = nodes[1][1];
    const answer2 = (JSON.parse(`"${nodes[1][2]}"`) as string).slice(0, 3);

    const body = {
      blanks: [
        { nodeId, answer, occurrence: 1, explanation: '按原文判断。', knowledgePoint: '知识点', acceptableAnswers: [] },
        { nodeId: nodeId2, answer: answer2, occurrence: 1, explanation: '按原文判断。', acceptableAnswers: [] },
        { nodeId: 't999999', answer: '不存在', occurrence: 1, explanation: 'x' }, // 无效节点
      ],
    };
    fake.replies = [{ body }];
    const res = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'cloze' }).expect(200);
    const ex = res.body.exercise;
    expect(ex.blanks.length).toBe(2);
    expect(ex.skipped).toBe(1);
    expect(ex.blanks[0].length).toBe([...answer].length);
    // 公开数据不得包含答案文本（路径中可能出现同样的字，因此只检查挖空负载）
    const blanksPayload = JSON.stringify(ex.blanks);
    expect(blanksPayload).not.toContain(answer);
    expect(blanksPayload).not.toContain(answer2);
    expect(Object.keys(ex.blanks[0]).sort()).toEqual(['end', 'id', 'length', 'nodeId', 'start']);

    // 判分支持同义答案与全半角/标点差异
    const grade = await request(app.ctx.app)
      .post(`/api/exercises/${ex.setId}/grade`)
      .send({ type: 'cloze', answers: { b1: ` ${answer}。 ` } })
      .expect(200);
    expect(grade.body.result.score).toBe(1);
    expect(grade.body.result.blanks[0].answer).toBe(answer);

    const wrong = await request(app.ctx.app)
      .post(`/api/exercises/${ex.setId}/grade`)
      .send({ type: 'cloze', answers: { b1: '完全不对' } })
      .expect(200);
    expect(wrong.body.result.score).toBe(0);
  });

  it('挖空题遇到无效 JSON、截断、空响应、网络错误时按重试次数重试并给出友好错误', async () => {
    const cases: Array<[Reply, string]> = [
      [{ raw: '这不是 JSON' }, 'invalid_json'],
      [{ status: 206, raw: '{"blanks":[' }, 'truncated'],
      [{ raw: '   ' }, 'empty_response'],
      [{ connectionDrop: true }, 'network'],
      [{ status: 429, body: { error: { message: 'rate limit' } } }, 'rate_limited'],
      [{ status: 500, body: { error: { message: 'internal' } } }, 'server_error'],
    ];
    for (const [reply, expected] of cases) {
      const app = await appWith(reply, { maxRetries: 1 });
      const res = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' });
      expect(res.status, expected).toBeGreaterThanOrEqual(500);
      expect(res.body.error.code, expected).toBe(expected);
      expect(typeof res.body.error.message, expected).toBe('string');
      expect(res.body.error.message.length, expected).toBeGreaterThan(4);
      expect(fake.calls.length, `${expected} 应重试一次`).toBe(2);
      await app.cleanup();
    }
  });

  it('请求超时返回明确提示', async () => {
    const app = await appWith({ body: goodMcq, delayMs: 700 }, { timeoutMs: 150, maxRetries: 0 });
    const res = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(504);
    expect(res.body.error.code).toBe('timeout');
  });

  it('认证与余额错误不重试', async () => {
    for (const [status, code] of [
      [401, 'auth'],
      [402, 'insufficient_balance'],
      [400, 'bad_request'],
    ] as const) {
      const app = await appWith({ status, body: { error: { message: 'x' } } }, { maxRetries: 2 });
      const res = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(502);
      expect(res.body.error.code).toBe(code);
      expect(fake.calls.length).toBe(1);
      await app.cleanup();
    }
  });

  it('结果被缓存：相同文档与提示词不重复调用 API', async () => {
    const app = await appWith({ body: goodMcq });
    await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(200);
    const callsAfterFirst = fake.calls.length;
    const second = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(200);
    expect(fake.calls.length).toBe(callsAfterFirst);
    expect(second.body.exercise.fromCache).toBe(true);

    // 主动重新生成会再次调用
    const forced = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq', force: true }).expect(200);
    expect(fake.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(forced.body.exercise.fromCache).toBe(false);
  });

  it('修改提示词文件后，缓存失效并使用新提示词', async () => {
    const app = await appWith({ body: goodMcq });
    await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(200);
    const before = fake.calls.length;

    const promptFile = `${app.dir}/prompts/mcq.md`;
    const original = await fs.readFile(promptFile, 'utf8');
    await fs.writeFile(promptFile, original.replace('请阅读下面的文章', '请非常仔细地阅读下面的文章（新版提示词）'), 'utf8');

    await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(200);
    expect(fake.calls.length).toBe(before + 1);
    expect(fake.calls.at(-1)!.messages.map((m) => m.content).join()).toContain('新版提示词');
  });

  it('问答题生成与点评：点评依据服务端保存的要点，支持重新提交', async () => {
    const app = await appWith({
      body: {
        questions: [
          {
            id: '1',
            question: '为什么说进程是资源分配的基本单位？',
            focus: '概念理解',
            difficulty: 'intermediate',
            keyPoints: ['拥有独立地址空间'],
            referenceAnswer: '参考答案内容',
            sources: [{ quote: '进程是操作系统进行资源分配的基本单位', section: '概述' }],
          },
        ],
      },
    });
    const gen = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'qa' }).expect(200);
    expect(JSON.stringify(gen.body)).not.toContain('keyPoints');
    expect(JSON.stringify(gen.body)).not.toContain('参考答案内容');

    fake.replies = [
      {
        body: {
          score: 88,
          overall: '整体不错',
          strengths: ['抓住了核心'],
          missingPoints: ['缺少对比'],
          errors: [],
          suggestions: ['补充线程对比'],
          referenceAnswer: '更完整的答案',
          evidence: [{ quote: '进程是操作系统进行资源分配的基本单位', explanation: '依据' }],
        },
      },
    ];
    const setId = gen.body.exercise.setId;
    const ev = await request(app.ctx.app).post(`/api/exercises/${setId}/qa/qa1/evaluate`).send({ answer: '因为进程有独立地址空间' }).expect(200);
    expect(ev.body.evaluation.score).toBe(88);
    expect(ev.body.evaluation.evidence[0].verified).toBe(true);
    // 点评提示词应包含评分要点
    expect(fake.calls.at(-1)!.messages.map((m) => m.content).join()).toContain('拥有独立地址空间');

    await request(app.ctx.app).post(`/api/exercises/${setId}/qa/qa1/evaluate`).send({ answer: '' }).expect(400);
    await request(app.ctx.app).post(`/api/exercises/${setId}/qa/nope/evaluate`).send({ answer: 'x' }).expect(404);
  });

  it('文档内容变化后缓存键变化，并可用文档哈希提示旧练习已过期', async () => {
    const app = await appWith({ body: goodMcq });
    const first = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(200);
    await fs.writeFile(`${app.learnDir}/操作系统/进程管理.md`, '# 进程管理\n\n内容已经改写。\n', 'utf8');
    const second = await request(app.ctx.app).post('/api/exercises/generate').send({ path: '操作系统/进程管理.md', type: 'mcq' }).expect(200);
    expect(second.body.exercise.docHash).not.toBe(first.body.exercise.docHash);
    expect(second.body.exercise.fromCache).toBe(false);
  });

  it('extractJson 兼容代码块与前后多余文字', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('好的，结果如下：{"a":1} 完毕')).toEqual({ a: 1 });
    expect(() => extractJson('没有 JSON')).toThrow(AiError);
  });
});
