// 对模型输出做语义校验：不信任模型生成的任何 ID、答案或引用
import { countOccurrences, indexOfOccurrence, normalizeAnswer, quoteAppearsIn } from '../../shared/normalize';
import type { ClozeTextNode } from '../../shared/markdown';
import type { QaEvidence, SourceRef } from '../../shared/types';
import type { ClozeAi, ClozeBlankFull, McqAi, McqQuestionFull, QaEvaluateAi, QaQuestionFull } from './schemas';
import type { z } from 'zod';
import type { qaGenerateAiSchema } from './schemas';

export interface Validated<T> {
  items: T[];
  skipped: number;
  warnings: string[];
}

function checkSource(src: { quote: string; section?: string }, plainNorm: string): SourceRef {
  const quote = src.quote.slice(0, 500);
  return { quote, section: src.section || undefined, verified: quote ? quoteAppearsIn(quote, plainNorm) : false };
}

// ---------------- 选择题 ----------------
export function validateMcq(ai: McqAi, plainNorm: string): Validated<McqQuestionFull> {
  const items: McqQuestionFull[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  ai.questions.forEach((q, qi) => {
    const label = `第 ${qi + 1} 题`;
    const ids = q.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) {
      skipped++;
      warnings.push(`${label}：选项 ID 重复，已丢弃`);
      return;
    }
    const texts = q.options.map((o) => normalizeAnswer(o.text) || o.text);
    if (new Set(texts).size !== texts.length) {
      skipped++;
      warnings.push(`${label}：存在内容相同的选项，已丢弃`);
      return;
    }
    const declared = [...new Set(q.correctOptionIds)];
    if (declared.some((id) => !ids.includes(id))) {
      skipped++;
      warnings.push(`${label}：正确答案引用了不存在的选项，已丢弃`);
      return;
    }
    const flagged = q.options.filter((o) => o.isCorrect).map((o) => o.id);
    const same = flagged.length === declared.length && flagged.every((id) => declared.includes(id));
    if (!same) {
      skipped++;
      warnings.push(`${label}：correctOptionIds 与选项 isCorrect 不一致，已丢弃`);
      return;
    }
    if (declared.length === q.options.length) {
      skipped++;
      warnings.push(`${label}：所有选项均为正确答案，已丢弃`);
      return;
    }
    let type = q.type;
    if (type === 'single' && declared.length !== 1) {
      type = 'multiple';
      warnings.push(`${label}：标注为单选但有多个正确答案，已改为多选`);
    } else if (type === 'multiple' && declared.length === 1) {
      type = 'single';
      warnings.push(`${label}：标注为多选但只有一个正确答案，已改为单选`);
    }
    // 选项 ID 统一重排为 A/B/C...，正确答案与解释随之映射，保证一致
    const letters = 'ABCDEFGH';
    const remap = new Map(ids.map((id, i) => [id, letters[i]]));
    items.push({
      id: `q${items.length + 1}`,
      type,
      stem: q.stem,
      options: q.options.map((o) => ({ id: remap.get(o.id)!, text: o.text, isCorrect: o.isCorrect, explanation: o.explanation })),
      correctOptionIds: ids.filter((id) => declared.includes(id)).map((id) => remap.get(id)!),
      explanation: q.explanation,
      knowledgePoint: q.knowledgePoint || undefined,
      source: checkSource(q.source, plainNorm),
    });
  });
  return { items, skipped, warnings };
}

// ---------------- 挖空题 ----------------
const MAX_ANSWER_LEN = 40;
const MAX_BLANKS_PER_NODE = 3;

export function validateCloze(ai: ClozeAi, nodes: ClozeTextNode[], maxBlanks: number): Validated<ClozeBlankFull> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const warnings: string[] = [];
  let skipped = 0;
  const accepted: Array<Omit<ClozeBlankFull, 'id'>> = [];
  const seen = new Set<string>();

  const skip = (reason: string) => {
    skipped++;
    warnings.push(reason);
  };

  for (const b of ai.blanks) {
    const node = nodeMap.get(b.nodeId);
    const answer = b.answer.trim();
    if (!node) {
      skip(`节点 ${b.nodeId} 不存在，已跳过`);
      continue;
    }
    if (!answer || answer.length > MAX_ANSWER_LEN) {
      skip(`节点 ${b.nodeId} 的答案为空或过长，已跳过`);
      continue;
    }
    if (!normalizeAnswer(answer)) {
      skip(`答案「${answer}」只包含标点，已跳过`);
      continue;
    }
    const count = countOccurrences(node.text, answer);
    if (count === 0) {
      skip(`答案「${answer}」与节点 ${b.nodeId} 的原文不匹配，已跳过`);
      continue;
    }
    let occurrence = b.occurrence;
    if (occurrence === undefined || occurrence > count) {
      if (count === 1) occurrence = 1;
      else {
        skip(`答案「${answer}」在节点 ${b.nodeId} 中出现 ${count} 次但出现序号无效，无法可靠定位，已跳过`);
        continue;
      }
    }
    const start = indexOfOccurrence(node.text, answer, occurrence);
    if (start < 0) {
      skip(`答案「${answer}」无法定位，已跳过`);
      continue;
    }
    const end = start + answer.length;
    const key = `${node.id}:${start}`;
    if (seen.has(key)) {
      skip(`答案「${answer}」重复，已跳过`);
      continue;
    }
    const sameNode = accepted.filter((a) => a.nodeId === node.id);
    if (sameNode.some((a) => start < a.end && end > a.start)) {
      skip(`答案「${answer}」与同一位置的其他挖空重叠，已跳过`);
      continue;
    }
    if (sameNode.length >= MAX_BLANKS_PER_NODE) {
      skip(`节点 ${node.id} 挖空过密，已跳过「${answer}」`);
      continue;
    }
    seen.add(key);
    const alternatives = (b.acceptableAnswers ?? [])
      .map((s) => s.trim())
      .filter((s) => s && s.length <= MAX_ANSWER_LEN * 2 && normalizeAnswer(s) && normalizeAnswer(s) !== normalizeAnswer(answer))
      .slice(0, 6);
    const ctxStart = Math.max(0, start - 40);
    const ctxEnd = Math.min(node.text.length, end + 40);
    accepted.push({
      nodeId: node.id,
      start,
      end,
      answer,
      acceptedAnswers: [...new Set(alternatives)],
      explanation: b.explanation || `原文此处为「${answer}」。`,
      knowledgePoint: b.knowledgePoint || undefined,
      context:
        (ctxStart > 0 ? '…' : '') +
        node.text.slice(ctxStart, start) +
        `【${answer}】` +
        node.text.slice(end, ctxEnd) +
        (ctxEnd < node.text.length ? '…' : ''),
    });
  }

  accepted.sort((a, b) => order.get(a.nodeId)! - order.get(b.nodeId)! || a.start - b.start);
  let items = accepted;
  if (items.length > maxBlanks) {
    warnings.push(`挖空数量超过上限 ${maxBlanks}，已截取`);
    items = items.slice(0, maxBlanks);
  }
  return { items: items.map((b, i) => ({ id: `b${i + 1}`, ...b })), skipped, warnings };
}

// ---------------- 问答题 ----------------
export function validateQa(ai: z.infer<typeof qaGenerateAiSchema>, plainNorm: string): Validated<QaQuestionFull> {
  const items: QaQuestionFull[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const q of ai.questions) {
    const key = normalizeAnswer(q.question);
    if (seen.has(key)) {
      skipped++;
      warnings.push('存在重复问题，已去重');
      continue;
    }
    seen.add(key);
    items.push({
      id: `qa${items.length + 1}`,
      question: q.question,
      focus: q.focus,
      difficulty: q.difficulty,
      keyPoints: q.keyPoints,
      referenceAnswer: q.referenceAnswer,
      sources: q.sources.filter((s) => s.quote).map((s) => checkSource(s, plainNorm)),
    });
  }
  return { items, skipped, warnings };
}

export function levelFromScore(score: number): 'excellent' | 'good' | 'fair' | 'poor' {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'fair';
  return 'poor';
}

export function normalizeEvaluation(ai: QaEvaluateAi, plainNorm: string) {
  const score = Math.round(Math.max(0, Math.min(100, ai.score)));
  const evidence: QaEvidence[] = ai.evidence
    .filter((e) => e.quote)
    .map((e) => ({ quote: e.quote.slice(0, 500), explanation: e.explanation, verified: quoteAppearsIn(e.quote, plainNorm) }));
  return {
    score,
    level: ai.level ?? levelFromScore(score),
    overall: ai.overall,
    strengths: ai.strengths,
    missingPoints: ai.missingPoints,
    errors: ai.errors,
    suggestions: ai.suggestions,
    referenceAnswer: ai.referenceAnswer,
    evidence,
  };
}
