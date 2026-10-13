// AI 返回数据的 Zod Schema，以及服务端保存的完整练习结构
import { z } from 'zod';
import type { SourceRef } from '../../shared/types';

const idLike = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const text = z.string().transform((s) => s.trim());
const nonEmpty = text.pipe(z.string().min(1));

const sourceSchema = z
  .object({
    quote: text.default(''),
    section: text.optional(),
  })
  .catch({ quote: '' });

// ---------------- 选择题 ----------------
export const mcqAiSchema = z.object({
  questions: z
    .array(
      z.object({
        id: idLike.optional(),
        type: z.enum(['single', 'multiple']),
        stem: nonEmpty,
        options: z
          .array(
            z.object({
              id: idLike.pipe(z.string().min(1)),
              text: nonEmpty,
              isCorrect: z.boolean(),
              explanation: nonEmpty,
            }),
          )
          .min(2)
          .max(8),
        correctOptionIds: z.array(idLike).min(1),
        explanation: nonEmpty,
        knowledgePoint: text.optional(),
        source: sourceSchema,
      }),
    )
    .min(1),
});
export type McqAi = z.infer<typeof mcqAiSchema>;

export interface McqQuestionFull {
  id: string;
  type: 'single' | 'multiple';
  stem: string;
  options: Array<{ id: string; text: string; isCorrect: boolean; explanation: string }>;
  correctOptionIds: string[];
  explanation: string;
  knowledgePoint?: string;
  source: SourceRef;
}

// ---------------- 挖空题 ----------------
export const clozeAiSchema = z.object({
  blanks: z
    .array(
      z.object({
        nodeId: idLike,
        answer: z.string(),
        occurrence: z.coerce.number().int().min(1).optional().catch(undefined),
        explanation: text.default(''),
        knowledgePoint: text.optional(),
        acceptableAnswers: z.array(z.string()).optional().catch([]),
      }),
    )
    .min(1),
});
export type ClozeAi = z.infer<typeof clozeAiSchema>;

export interface ClozeBlankFull {
  id: string;
  nodeId: string;
  start: number;
  end: number;
  answer: string;
  acceptedAnswers: string[];
  explanation: string;
  knowledgePoint?: string;
  context: string;
}

// ---------------- 问答题 ----------------
export const qaGenerateAiSchema = z.object({
  questions: z
    .array(
      z.object({
        id: idLike.optional(),
        question: nonEmpty,
        focus: text.default(''),
        difficulty: z.enum(['basic', 'intermediate', 'advanced']).catch('intermediate'),
        keyPoints: z.array(nonEmpty).min(1),
        referenceAnswer: nonEmpty,
        sources: z.array(sourceSchema).default([]),
      }),
    )
    .min(1),
});

export interface QaQuestionFull {
  id: string;
  question: string;
  focus: string;
  difficulty: 'basic' | 'intermediate' | 'advanced';
  keyPoints: string[];
  referenceAnswer: string;
  sources: SourceRef[];
}

const strList = z
  .array(z.union([z.string(), z.number()]).transform((s) => String(s).trim()))
  .default([])
  .transform((arr) => arr.filter((s) => s.length > 0));

export const qaEvaluateAiSchema = z.object({
  score: z.coerce.number().min(0).max(100),
  level: z.enum(['excellent', 'good', 'fair', 'poor']).optional().catch(undefined),
  overall: nonEmpty,
  strengths: strList,
  missingPoints: strList,
  errors: strList,
  suggestions: strList,
  referenceAnswer: nonEmpty,
  evidence: z
    .array(z.object({ quote: text.default(''), explanation: text.default('') }).catch({ quote: '', explanation: '' }))
    .default([]),
});
export type QaEvaluateAi = z.infer<typeof qaEvaluateAiSchema>;
