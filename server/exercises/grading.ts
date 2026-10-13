// 判分：选择题与挖空题由服务端确定性判分，答案不会在提交前下发给浏览器
import fs from 'node:fs/promises';
import { normalizeAnswer } from '../../shared/normalize';
import type { ClozeBlankResult, ClozeGradeResult, McqGradeResult, McqQuestionResult } from '../../shared/types';
import type { ClozeBlankFull, McqQuestionFull } from './schemas';

export function gradeMcq(questions: McqQuestionFull[], answers: Record<string, unknown>): McqGradeResult {
  const results: McqQuestionResult[] = questions.map((q) => {
    const raw = answers[q.id];
    const validIds = new Set(q.options.map((o) => o.id));
    const selected = Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === 'string' && validIds.has(x)))] : [];
    const effective = q.type === 'single' ? selected.slice(0, 1) : selected;
    const correct = effective.length === q.correctOptionIds.length && effective.every((id) => q.correctOptionIds.includes(id));
    return {
      id: q.id,
      type: q.type,
      stem: q.stem,
      correct,
      selectedOptionIds: effective,
      correctOptionIds: q.correctOptionIds,
      options: q.options.map((o) => ({ ...o, selected: effective.includes(o.id) })),
      explanation: q.explanation,
      knowledgePoint: q.knowledgePoint,
      source: q.source,
    };
  });
  return {
    type: 'mcq',
    score: results.filter((r) => r.correct).length,
    total: results.length,
    questions: results,
    gradedAt: new Date().toISOString(),
  };
}

/** 同义词配置：config/synonyms.json，格式为同义词组数组，例如 [["TCP", "传输控制协议"]] */
export async function loadSynonyms(file: string): Promise<string[][]> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    const groups = Array.isArray(raw) ? raw : Array.isArray((raw as { groups?: unknown })?.groups) ? (raw as { groups: unknown[] }).groups : [];
    return groups.filter((g): g is string[] => Array.isArray(g) && g.every((s) => typeof s === 'string'));
  } catch {
    return [];
  }
}

export function isClozeAnswerCorrect(user: string, blank: Pick<ClozeBlankFull, 'answer' | 'acceptedAnswers'>, synonyms: string[][] = []): boolean {
  const u = normalizeAnswer(user);
  if (!u) return false;
  const accepted = new Set([blank.answer, ...blank.acceptedAnswers].map(normalizeAnswer).filter(Boolean));
  for (const group of synonyms) {
    const norm = group.map(normalizeAnswer).filter(Boolean);
    if (norm.some((s) => accepted.has(s))) norm.forEach((s) => accepted.add(s));
  }
  return accepted.has(u);
}

export function gradeCloze(blanks: ClozeBlankFull[], answers: Record<string, unknown>, synonyms: string[][]): ClozeGradeResult {
  const results: ClozeBlankResult[] = blanks.map((b) => {
    const user = typeof answers[b.id] === 'string' ? (answers[b.id] as string).slice(0, 200) : '';
    return {
      id: b.id,
      nodeId: b.nodeId,
      userAnswer: user,
      correct: isClozeAnswerCorrect(user, b, synonyms),
      answer: b.answer,
      acceptedAnswers: b.acceptedAnswers,
      explanation: b.explanation,
      knowledgePoint: b.knowledgePoint,
      context: b.context,
    };
  });
  return {
    type: 'cloze',
    score: results.filter((r) => r.correct).length,
    total: results.length,
    blanks: results,
    gradedAt: new Date().toISOString(),
  };
}
