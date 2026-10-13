#!/usr/bin/env tsx
/**
 * 本地模拟 DeepSeek 服务，用于端到端测试与调试（不依赖真实 API Key）。
 *
 *   npm run mock:deepseek                 # 按提示词自动生成合理的假答案
 *   MOCK_SCRIPT=script.json npm run mock:deepseek
 *
 * script.json 格式：
 *   { "mcq": ["{...原始输出...}"], "cloze": ["!500 服务错误"], "default": ["{...}"] }
 *   取值规则：按提示词自动识别题型 → 取该题型脚本的第 n 次调用（超出则用最后一条）→ 最后回退到 default。
 *   脚本项以 "!" 开头表示返回 HTTP 错误，形如 "!429 rate limited"。
 */
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = Number(process.env.MOCK_PORT || 3010);
const SCRIPT_FILE = process.env.MOCK_SCRIPT;
const DIR = path.dirname(fileURLToPath(import.meta.url));

function detectKind(prompt: string): 'mcq' | 'cloze' | 'qa_generate' | 'qa_evaluate' | 'default' {
  if (prompt.includes('"blanks"') || prompt.includes('可挖空文本节点')) return 'cloze';
  if (prompt.includes('"evidence"') || prompt.includes('学习者答案')) return 'qa_evaluate';
  if (prompt.includes('"keyPoints"') || prompt.includes('开放式问答题')) return 'qa_generate';
  if (prompt.includes('"correctOptionIds"') || prompt.includes('选择题')) return 'mcq';
  return 'default';
}

// ---------- 默认的可信输出 ----------
function nodeIdFor(prompt: string, answer: string): { nodeId: string; occurrence: number } | null {
  // 从提示词中的节点列表里找出包含该答案的节点（模拟真实的“依据 AST 出题”）
  const re = /"id":\s*"(t\d+)",\s*"text":\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    const text = JSON.parse(`"${m[2]}"`) as string;
    const idx = text.indexOf(answer);
    if (idx >= 0) {
      let count = 0;
      let from = 0;
      for (;;) {
        const at = text.indexOf(answer, from);
        if (at < 0) break;
        count++;
        if (at === idx) break;
        from = at + answer.length;
      }
      return { nodeId: m[1], occurrence: count };
    }
  }
  return null;
}

function defaultResponse(kind: string, prompt: string): string {
  if (kind === 'cloze') {
    const blanks = [
      { answer: '资源分配', explanation: '进程是资源分配的基本单位。', knowledgePoint: '进程的定义' },
      { answer: '就绪态', explanation: '就绪态指进程已具备运行条件，只等 CPU。', knowledgePoint: '进程状态' },
      { answer: '阻塞态', explanation: '阻塞态指进程等待事件完成。', knowledgePoint: '进程状态' },
    ];
    const out = blanks
      .map((b) => {
        const found = nodeIdFor(prompt, b.answer);
        return found ? { nodeId: found.nodeId, answer: b.answer, occurrence: found.occurrence, explanation: b.explanation, knowledgePoint: b.knowledgePoint, acceptableAnswers: [] } : null;
      })
      .filter(Boolean);
    if (out.length === 0) {
      const m = /"id":\s*"(t\d+)",\s*"text":\s*"((?:[^"\\]|\\.)*)"/.exec(prompt);
      const text = m ? (JSON.parse(`"${m[2]}"`) as string) : '正文';
      const answer = text.slice(0, 2);
      out.push({ nodeId: m ? m[1] : 't0', answer, occurrence: 1, explanation: '按原文判断。', knowledgePoint: '知识点', acceptableAnswers: [] });
    }
    return JSON.stringify({ blanks: out });
  }
  if (kind === 'qa_evaluate') {
    return JSON.stringify({
      score: 78,
      level: 'good',
      overall: '答案抓住了主要概念，但缺少对因果关系的说明。',
      strengths: ['正确指出进程是资源分配的基本单位'],
      missingPoints: ['没有说明阻塞态不能直接转为运行态'],
      errors: [],
      suggestions: ['补充状态转换的约束条件'],
      referenceAnswer: '进程是操作系统进行资源分配和调度的基本单位……',
      evidence: [{ quote: '进程是操作系统进行资源分配的基本单位', explanation: '这是答案中已经提到的依据' }],
    });
  }
  if (kind === 'qa_generate') {
    return JSON.stringify({
      questions: [
        {
          id: '1',
          question: '为什么说进程是资源分配的基本单位？请结合线程的区别说明。',
          focus: '概念理解与对比',
          difficulty: 'intermediate',
          keyPoints: ['进程拥有独立的地址空间', '线程共享进程资源'],
          referenceAnswer: '因为进程拥有独立的地址空间与资源……',
          sources: [{ quote: '进程是操作系统进行资源分配的基本单位', section: '概述' }],
        },
      ],
    });
  }
  return JSON.stringify({
    questions: [
      {
        id: '1',
        type: 'single',
        stem: '进程作为资源分配的基本单位，其控制块 PCB 的作用是什么？',
        options: [
          { id: 'A', text: '保存进程运行所需的所有资源数据', isCorrect: false, explanation: '资源数据保存在数据段中，而不是 PCB。' },
          { id: 'B', text: '作为操作系统感知进程存在的唯一标志', isCorrect: true, explanation: '原文指出 PCB 是操作系统感知进程存在的标志。' },
          { id: 'C', text: '决定进程的优先级', isCorrect: false, explanation: '优先级只是 PCB 中保存的部分信息。' },
          { id: 'D', text: '存放进程的可执行代码', isCorrect: false, explanation: '可执行代码位于程序段。' },
        ],
        correctOptionIds: ['B'],
        explanation: '本题考查对 PCB 作用的理解。',
        knowledgePoint: '进程控制块',
        source: { quote: '进程是操作系统进行资源分配的基本单位', section: '概述' },
      },
      {
        id: '2',
        type: 'multiple',
        stem: '关于进程状态转换，下列说法正确的是？',
        options: [
          { id: 'A', text: '时间片用完后运行态转为就绪态', isCorrect: true, explanation: '符合原文中的状态转换规则。' },
          { id: 'B', text: '阻塞态可以直接转为运行态', isCorrect: false, explanation: '原文明确指出阻塞态必须先进入就绪态。' },
          { id: 'C', text: '等待事件发生时运行态转为阻塞态', isCorrect: true, explanation: '这是典型的主动阻塞。' },
          { id: 'D', text: '就绪态的进程一定在等待 I/O', isCorrect: false, explanation: '就绪态只在等待 CPU。' },
        ],
        correctOptionIds: ['A', 'C'],
        explanation: '本题考查进程状态转换的约束。',
        knowledgePoint: '进程状态',
        source: { quote: '阻塞态不能直接转换为运行态，必须先进入就绪态', section: '进程的状态' },
      },
    ],
  });
}

// ---------- 脚本模式 ----------
function loadScript(): Record<string, string[]> | null {
  if (!SCRIPT_FILE) return null;
  const file = path.isAbsolute(SCRIPT_FILE) ? SCRIPT_FILE : path.join(DIR, SCRIPT_FILE);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string[]>;
  } catch {
    return null;
  }
}

const counters = new Map<string, number>();
const used = new Set<number>();

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end('{}');
      return;
    }
    let payload: { messages?: Array<{ role: string; content: string }>; model?: string } = {};
    try {
      payload = JSON.parse(body);
    } catch {
      /* ignore */
    }
    const prompt = payload.messages?.map((m) => m.content).join('\n') ?? '';
    const kind = detectKind(prompt);
    const script = loadScript();
    let content = '';
    let status = 200;
    if (script) {
      const list = script[kind] ?? script.default ?? [];
      const n = counters.get(kind) ?? 0;
      counters.set(kind, n + 1);
      const chosen = list[Math.min(n, list.length - 1)];
      if (chosen === undefined) {
        status = 500;
        content = 'mock: no scripted response';
      } else if (chosen.startsWith('!')) {
        const [code, ...rest] = chosen.slice(1).split(' ');
        status = Number(code) || 500;
        content = rest.join(' ') || 'mock error';
      } else {
        content = chosen;
      }
    } else {
      content = defaultResponse(kind, prompt);
    }

    used.add(1);
    const id = `mock-${used.size}`;
    console.log(`[mock] ${kind} → HTTP ${status}（第 ${(counters.get(kind) ?? 1)} 次调用）`);

    const reply = (obj: unknown, code = 200) => {
      const text = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(text);
    };

    if (status !== 200) {
      reply({ error: { message: content, type: 'mock_error' } }, status);
      return;
    }
    if (body.includes('"stream":true')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    reply({
      id,
      object: 'chat.completion',
      model: payload.model ?? 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: prompt.length, completion_tokens: content.length, total_tokens: prompt.length + content.length },
    });
  });
});

server.listen(PORT, () => console.log(`🧪 模拟 DeepSeek 服务已启动：http://127.0.0.1:${PORT}${SCRIPT_FILE ? `（脚本：${SCRIPT_FILE}）` : ''}`));
