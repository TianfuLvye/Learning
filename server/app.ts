import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import type { AppConfig } from './config';
import type { ExerciseType } from '../shared/types';
import { HttpError } from './lib/errors';
import { resolveInside } from './lib/safePath';
import { AiError, DeepSeekClient } from './ai/deepseek';
import { ProgressStore, isLearnStatus } from './services/progress';
import { ScoreStore } from './services/scores';
import { Library } from './services/library';
import { PromptLoader } from './services/prompts';
import { EventHub } from './services/events';
import { ExerciseStore } from './exercises/store';
import { ExerciseService } from './exercises/service';

const ASSET_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

const EXERCISE_TYPES: ExerciseType[] = ['mcq', 'cloze', 'qa'];

function parseType(v: unknown): ExerciseType {
  if (typeof v === 'string' && (EXERCISE_TYPES as string[]).includes(v)) return v as ExerciseType;
  throw new HttpError(400, 'bad_type', '练习类型无效');
}

/** 客户端断开（例如点击“取消”）时中止上游 AI 请求 */
function abortOnClose(res: Response): AbortSignal {
  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctrl.abort();
  });
  return ctrl.signal;
}

export interface AppContext {
  app: express.Express;
  events: EventHub;
  services: { library: Library; progress: ProgressStore; scores: ScoreStore; exercises: ExerciseService; ai: DeepSeekClient };
}

export function createApp(config: AppConfig): AppContext {
  fs.mkdirSync(config.learnDir, { recursive: true });
  const progress = new ProgressStore(config.learnDir);
  const scores = new ScoreStore(config.learnDir);
  const library = new Library(config.learnDir, progress);
  const prompts = new PromptLoader(config.promptsDir);
  const ai = new DeepSeekClient(config.ai);
  const exercises = new ExerciseService({
    library,
    prompts,
    ai,
    store: new ExerciseStore(path.join(config.cacheDir, 'exercises')),
    scores,
    synonymsFile: config.synonymsFile,
  });
  const events = new EventHub();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const api = express.Router();

  api.get('/config', (_req, res) => {
    res.json({ aiConfigured: ai.configured, model: config.ai.model, baseUrl: config.ai.baseUrl });
  });

  api.get('/tree', async (_req, res) => {
    res.json(await library.tree());
  });

  api.get('/doc', async (req, res) => {
    res.json(await library.readDoc(req.query.path));
  });

  api.get('/asset', async (req, res) => {
    const { abs, rel } = await resolveInside(config.learnDir, req.query.path);
    const ext = path.extname(rel).toLowerCase();
    const type = ASSET_TYPES[ext];
    if (!type) throw new HttpError(415, 'unsupported_asset', '不支持的文件类型');
    if (!fs.statSync(abs).isFile()) throw new HttpError(404, 'not_found', '文件不存在');
    // 资源以沙箱方式返回：即使是 SVG 也无法执行脚本
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'no-cache');
    res.type(type);
    res.sendFile(abs, { dotfiles: 'deny' });
  });

  api.get('/events', (_req, res) => {
    events.attach(res);
  });

  api.post('/progress/open', async (req, res) => {
    const doc = await library.readDoc(req.body?.path);
    const status = await progress.markOpened(doc.path, doc.hash);
    events.emit({ type: 'progress' });
    res.json({ path: doc.path, status });
  });

  api.put('/progress', async (req, res) => {
    const status = req.body?.status;
    if (!isLearnStatus(status)) throw new HttpError(400, 'bad_status', '学习状态无效');
    const doc = await library.readDoc(req.body?.path);
    const entry = await progress.setStatus(doc.path, status, doc.hash);
    events.emit({ type: 'progress' });
    res.json({ path: doc.path, ...entry });
  });

  api.get('/scores', async (req, res) => {
    const { rel } = await resolveInside(config.learnDir, req.query.path);
    res.json(await scores.get(rel));
  });

  api.get('/exercises', async (req, res) => {
    const type = parseType(req.query.type);
    res.json({ exercise: await exercises.getCached(String(req.query.path ?? ''), type) });
  });

  api.post('/exercises/generate', async (req, res) => {
    const type = parseType(req.body?.type);
    const signal = abortOnClose(res);
    const exercise = await exercises.generate(req.body?.path, type, { force: req.body?.force === true, signal });
    res.json({ exercise });
  });

  api.post('/exercises/:setId/grade', async (req, res) => {
    const type = req.body?.type;
    if (type !== 'mcq' && type !== 'cloze') throw new HttpError(400, 'bad_type', '题型错误');
    const answers = req.body?.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new HttpError(400, 'bad_answers', '答案格式错误');
    res.json({ result: await exercises.grade(String(req.params.setId), type, answers) });
  });

  api.post('/exercises/:setId/qa/:questionId/evaluate', async (req, res) => {
    const answer = typeof req.body?.answer === 'string' ? req.body.answer.trim() : '';
    if (!answer) throw new HttpError(400, 'empty_answer', '请先填写答案');
    if (answer.length > 5000) throw new HttpError(400, 'answer_too_long', '答案过长（最多 5000 字）');
    const signal = abortOnClose(res);
    res.json({ evaluation: await exercises.evaluateQa(String(req.params.setId), String(req.params.questionId), answer, signal) });
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'not_found', '接口不存在')));

  app.use('/api', api);

  if (config.staticDir && fs.existsSync(config.staticDir)) {
    const staticDir = config.staticDir;
    app.use((_req, res, next) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: https: http:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      );
      next();
    });
    app.use(express.static(staticDir, { index: 'index.html' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, detail: err.detail } });
      return;
    }
    if (err instanceof AiError) {
      res.status(err.httpStatus).json({ error: { code: err.code, message: err.message, detail: err.detail } });
      return;
    }
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'bad_json', message: '请求体不是有效的 JSON' } });
      return;
    }
    console.error('[server]', err);
    res.status(500).json({ error: { code: 'internal', message: '服务器内部错误' } });
  });

  return { app, events, services: { library, progress, scores, exercises, ai } };
}
