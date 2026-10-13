// 练习生成服务：读取文档 → 读取提示词 → 调用 DeepSeek → 校验 → 缓存
import crypto from 'node:crypto';
import type { ExerciseType, PublicExercise, QaEvaluation } from '../../shared/types';
import { collectClozeNodes, groupClozeNodesByBlock, parseMarkdown, toAiText, toPlainText } from '../../shared/markdown';
import { normalizeForMatch } from '../../shared/normalize';
import { AiError, type DeepSeekClient } from '../ai/deepseek';
import { HttpError } from '../lib/errors';
import type { Library } from '../services/library';
import { renderTemplate, type PromptLoader, type PromptName } from '../services/prompts';
import type { ScoreStore } from '../services/scores';
import { cacheKey, type ExerciseStore, type StoredExercise } from './store';
import { clozeAiSchema, mcqAiSchema, qaEvaluateAiSchema, qaGenerateAiSchema } from './schemas';
import { normalizeEvaluation, validateCloze, validateMcq, validateQa } from './validate';
import { gradeCloze, gradeMcq, loadSynonyms } from './grading';

const AI_TEXT_LIMIT = 30_000;
const PROMPT_OF: Record<ExerciseType, PromptName> = { mcq: 'mcq', cloze: 'cloze', qa: 'qa_generate' };

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function limitText(text: string): string {
  if (text.length <= AI_TEXT_LIMIT) return text;
  return text.slice(0, AI_TEXT_LIMIT) + '\n\n[文章过长，后续内容已截断，请只依据以上内容出题]';
}

export function toPublic(set: StoredExercise, fromCache: boolean): PublicExercise {
  const meta = {
    setId: set.setId,
    path: set.path,
    docHash: set.docHash,
    promptVersion: set.promptVersion,
    model: set.model,
    createdAt: set.createdAt,
    skipped: set.skipped,
    warnings: set.warnings,
    fromCache,
  };
  switch (set.type) {
    case 'mcq':
      return {
        ...meta,
        type: 'mcq',
        questions: set.questions.map((q) => ({ id: q.id, type: q.type, stem: q.stem, options: q.options.map((o) => ({ id: o.id, text: o.text })) })),
      };
    case 'cloze':
      return {
        ...meta,
        type: 'cloze',
        blanks: set.blanks.map((b) => ({ id: b.id, nodeId: b.nodeId, start: b.start, end: b.end, length: [...b.answer].length })),
      };
    case 'qa':
      return {
        ...meta,
        type: 'qa',
        questions: set.questions.map((q) => ({ id: q.id, question: q.question, focus: q.focus, difficulty: q.difficulty })),
      };
  }
}

export class ExerciseService {
  constructor(
    private deps: {
      library: Library;
      prompts: PromptLoader;
      ai: DeepSeekClient;
      store: ExerciseStore;
      scores: ScoreStore;
      synonymsFile: string;
    },
  ) {}

  private async keyFor(path: string, type: ExerciseType) {
    const doc = await this.deps.library.readDoc(path);
    const prompt = await this.deps.prompts.load(PROMPT_OF[type]);
    const key = cacheKey({ type, path: doc.path, docHash: doc.hash, promptVersion: prompt.version, modelSignature: this.deps.ai.modelSignature });
    return { doc, prompt, key };
  }

  /** 只查询缓存，不调用 AI */
  async getCached(path: string, type: ExerciseType): Promise<PublicExercise | null> {
    const { key } = await this.keyFor(path, type);
    const set = await this.deps.store.getByKey(key);
    return set ? toPublic(set, true) : null;
  }

  async generate(path: string, type: ExerciseType, opts: { force?: boolean; signal?: AbortSignal }): Promise<PublicExercise> {
    const { doc, prompt, key } = await this.keyFor(path, type);
    if (!opts.force) {
      const cached = await this.deps.store.getByKey(key);
      if (cached) return toPublic(cached, true);
    }
    if (!this.deps.ai.configured) throw new AiError('not_configured');

    const tree = parseMarkdown(doc.content);
    const plainNorm = normalizeForMatch(toPlainText(tree));
    const article = limitText(toAiText(doc.content, tree));
    const len = toPlainText(tree).length;
    const base = {
      setId: crypto.randomUUID(),
      path: doc.path,
      docHash: doc.hash,
      promptVersion: prompt.version,
      model: this.deps.ai.model,
      createdAt: new Date().toISOString(),
    };
    const messages = (vars: Record<string, string | number>) => [
      { role: 'system' as const, content: renderTemplate(prompt.system, vars) },
      { role: 'user' as const, content: renderTemplate(prompt.user, vars) },
    ];

    let set: StoredExercise;
    if (type === 'mcq') {
      const count = clamp(len / 500, 3, 10);
      let result: ReturnType<typeof validateMcq> | null = null;
      await this.deps.ai.chatJson({
        label: 'mcq',
        schema: mcqAiSchema,
        signal: opts.signal,
        messages: messages({ title: doc.title, path: doc.path, article, count }),
        postValidate: (data) => {
          const r = validateMcq(data, plainNorm);
          if (r.items.length === 0) throw new AiError('invalid_content', r.warnings.join('; '));
          result = r;
          return data;
        },
      });
      const r = result!;
      set = { ...base, type: 'mcq', questions: r.items, skipped: r.skipped, warnings: r.warnings };
    } else if (type === 'cloze') {
      const nodes = collectClozeNodes(tree, 2);
      if (nodes.length === 0) throw new HttpError(422, 'no_cloze_nodes', '文章中没有适合挖空的正文文本');
      const blocks = groupClozeNodesByBlock(tree, nodes);
      const payload: unknown[] = [];
      let size = 0;
      const included: typeof nodes = [];
      for (const b of blocks) {
        const item = { block: b.block, type: b.blockType, context: b.blockText.slice(0, 600), nodes: b.nodes.map((n) => ({ id: n.id, text: n.text })) };
        const s = JSON.stringify(item).length;
        if (size + s > AI_TEXT_LIMIT && payload.length > 0) break;
        payload.push(item);
        included.push(...b.nodes);
        size += s;
      }
      const totalChars = included.reduce((s, n) => s + n.text.length, 0);
      const count = clamp(totalChars / 120, 3, 15);
      let result: ReturnType<typeof validateCloze> | null = null;
      await this.deps.ai.chatJson({
        label: 'cloze',
        schema: clozeAiSchema,
        signal: opts.signal,
        messages: messages({ title: doc.title, path: doc.path, nodes: JSON.stringify(payload, null, 1), count }),
        postValidate: (data) => {
          const r = validateCloze(data, included, count + 5);
          // 有效挖空过少时视为生成失败，触发重新生成
          if (r.items.length === 0 || (r.items.length < Math.min(3, count) && r.skipped > r.items.length)) {
            throw new AiError('invalid_content', `有效挖空过少：${r.warnings.slice(0, 5).join('; ')}`);
          }
          result = r;
          return data;
        },
      });
      const r = result!;
      set = { ...base, type: 'cloze', blanks: r.items, skipped: r.skipped, warnings: r.warnings };
    } else {
      const count = clamp(len / 1200, 2, 5);
      let result: ReturnType<typeof validateQa> | null = null;
      await this.deps.ai.chatJson({
        label: 'qa_generate',
        schema: qaGenerateAiSchema,
        signal: opts.signal,
        messages: messages({ title: doc.title, path: doc.path, article, count }),
        postValidate: (data) => {
          const r = validateQa(data, plainNorm);
          if (r.items.length === 0) throw new AiError('invalid_content', '没有有效问题');
          result = r;
          return data;
        },
      });
      const r = result!;
      set = { ...base, type: 'qa', questions: r.items, skipped: r.skipped, warnings: r.warnings };
    }

    await this.deps.store.save(key, set);
    return toPublic(set, false);
  }

  private async requireSet(setId: string, type: ExerciseType): Promise<StoredExercise> {
    const set = await this.deps.store.getSet(setId);
    if (!set || set.type !== type) throw new HttpError(404, 'set_not_found', '练习不存在或已过期，请重新生成');
    return set;
  }

  async grade(setId: string, type: 'mcq' | 'cloze', answers: Record<string, unknown>) {
    const set = await this.requireSet(setId, type);
    const result =
      set.type === 'mcq'
        ? gradeMcq(set.questions, answers)
        : set.type === 'cloze'
          ? gradeCloze(set.blanks, answers, await loadSynonyms(this.deps.synonymsFile))
          : null;
    if (!result) throw new HttpError(400, 'bad_type', '题型错误');
    await this.deps.scores.record(set.path, type, setId, result.score, result.total);
    return result;
  }

  async evaluateQa(setId: string, questionId: string, answer: string, signal?: AbortSignal): Promise<QaEvaluation> {
    const set = await this.requireSet(setId, 'qa');
    if (set.type !== 'qa') throw new HttpError(400, 'bad_type', '题型错误');
    const q = set.questions.find((x) => x.id === questionId);
    if (!q) throw new HttpError(404, 'question_not_found', '问题不存在');
    if (!this.deps.ai.configured) throw new AiError('not_configured');

    const prompt = await this.deps.prompts.load('qa_evaluate');
    let content = '';
    let plainNorm = '';
    try {
      const doc = await this.deps.library.readDoc(set.path);
      const tree = parseMarkdown(doc.content);
      content = limitText(toAiText(doc.content, tree));
      plainNorm = normalizeForMatch(toPlainText(tree));
    } catch {
      content = '[原文已不可用，仅依据参考要点评价]';
    }
    const vars = {
      title: set.path,
      question: q.question,
      focus: q.focus || '综合理解',
      keyPoints: q.keyPoints.map((k, i) => `${i + 1}. ${k}`).join('\n'),
      referenceAnswer: q.referenceAnswer,
      sources: q.sources.length ? q.sources.map((s) => `- ${s.quote}`).join('\n') : '（无）',
      article: content,
      answer: answer,
    };
    const { data } = await this.deps.ai.chatJson({
      label: 'qa_evaluate',
      schema: qaEvaluateAiSchema,
      signal,
      temperature: 0.2,
      messages: [
        { role: 'system', content: renderTemplate(prompt.system, vars) },
        { role: 'user', content: renderTemplate(prompt.user, vars) },
      ],
    });
    const evaluation = normalizeEvaluation(data, plainNorm);
    await this.deps.scores.record(set.path, 'qa', setId, evaluation.score, 100, questionId);
    return { questionId, answer, ...evaluation, evaluatedAt: new Date().toISOString() };
  }
}
