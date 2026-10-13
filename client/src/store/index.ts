import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PublicExercise } from '@shared/types';
import { api, ApiError } from '../lib/api';

export type AppMode = 'read' | 'practice' | 'review';

interface SettingsState {
  fontSize: number;
  lineHeight: number;
  readWidth: number;
  sidebarCollapsed: boolean;
  feedbackCollapsed: boolean;
  feedbackWidth: number;
  syncedScroll: boolean;
  mode: AppMode;
  currentPath: string | null;
  setFontSize: (v: number) => void;
  setLineHeight: (v: number) => void;
  setReadWidth: (v: number) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setFeedbackCollapsed: (v: boolean) => void;
  setFeedbackWidth: (v: number) => void;
  setSyncedScroll: (v: boolean) => void;
  setMode: (m: AppMode) => void;
  setCurrentPath: (p: string | null) => void;
  reset: () => void;
}

const defaults = {
  fontSize: 17,
  lineHeight: 1.75,
  readWidth: 34,
  sidebarCollapsed: false,
  feedbackCollapsed: false,
  feedbackWidth: 460,
  syncedScroll: true,
  mode: 'read' as AppMode,
  currentPath: null as string | null,
};

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaults,
      setFontSize: (fontSize) => set({ fontSize: clamp(fontSize, 13, 26) }),
      setLineHeight: (lineHeight) => set({ lineHeight: clamp(lineHeight, 1.4, 2.4) }),
      setReadWidth: (readWidth) => set({ readWidth: clamp(readWidth, 22, 60) }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setFeedbackCollapsed: (feedbackCollapsed) => set({ feedbackCollapsed }),
      setFeedbackWidth: (feedbackWidth) => set({ feedbackWidth: clamp(feedbackWidth, 320, 900) }),
      setSyncedScroll: (syncedScroll) => set({ syncedScroll }),
      setMode: (mode) => set({ mode }),
      setCurrentPath: (currentPath) => set({ currentPath }),
      reset: () => set({ ...defaults }),
    }),
    {
      name: 'mdlearn:settings',
      version: 1,
      partialize: (s) => ({
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
        readWidth: s.readWidth,
        sidebarCollapsed: s.sidebarCollapsed,
        feedbackCollapsed: s.feedbackCollapsed,
        feedbackWidth: s.feedbackWidth,
        syncedScroll: s.syncedScroll,
        mode: s.mode,
        currentPath: s.currentPath,
      }),
    },
  ),
);

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** 阅读位置（按块索引记录，字号变化后仍然有效） */
interface ReadingState {
  positions: Record<string, number>;
  setPosition: (path: string, block: number) => void;
}
export const useReading = create<ReadingState>()(
  persist(
    (set) => ({
      positions: {},
      setPosition: (path, block) => set((s) => ({ positions: { ...s.positions, [path]: block } })),
    }),
    { name: 'mdlearn:reading', version: 1 },
  ),
);

// ---------------- 练习：答题内容与结果（本地保存，刷新不丢失） ----------------
export interface StoredQa {
  draft: string;
  evaluation?: {
    score: number;
    level: string;
    overall: string;
    strengths: string[];
    missingPoints: string[];
    errors: string[];
    suggestions: string[];
    referenceAnswer: string;
    evidence: Array<{ quote: string; explanation: string; verified?: boolean }>;
    evaluatedAt: string;
    answer: string;
  };
}

export interface ExerciseState {
  sets: Partial<Record<'mcq' | 'cloze' | 'qa', PublicExercise>>;
  /** 记录生成时的文档哈希，文档变化后提示重新生成 */
  answers: Record<string, { mcq: Record<string, string[]>; cloze: Record<string, string> }>;
  results: Record<string, { mcq?: import('@shared/types').McqGradeResult; cloze?: import('@shared/types').ClozeGradeResult }>;
  qa: Record<string, Record<string, StoredQa>>;
  activeTab: 'mcq' | 'cloze' | 'qa';
  loading: Partial<Record<'mcq' | 'cloze' | 'qa', boolean>>;
  errors: Partial<Record<'mcq' | 'cloze' | 'qa' | 'qa_eval', string | null>>;
  dirty: boolean;
  setActiveTab: (t: 'mcq' | 'cloze' | 'qa') => void;
  setLoading: (t: 'mcq' | 'cloze' | 'qa', v: boolean) => void;
  setError: (k: 'mcq' | 'cloze' | 'qa' | 'qa_eval', v: string | null) => void;
  generate: (path: string, type: 'mcq' | 'cloze' | 'qa', force: boolean) => Promise<void>;
  /** 取消正在进行的生成请求 */
  cancelGenerate: (type: 'mcq' | 'cloze' | 'qa') => void;
  loadCached: (path: string) => Promise<void>;
  setAnswer: (path: string, type: 'mcq' | 'cloze', id: string, value: string[] | string) => void;
  setQaDraft: (path: string, qid: string, draft: string) => void;
  setQaEvaluation: (path: string, qid: string, evaluation: StoredQa['evaluation']) => void;
  submit: (path: string, type: 'mcq' | 'cloze') => Promise<void>;
  resetAnswers: (path: string, type: 'mcq' | 'cloze') => void;
  clear: () => void;
}

/** 每种题型同时只保留一个生成请求，切换文档或点击取消时中止 */
const generateControllers: Partial<Record<'mcq' | 'cloze' | 'qa', AbortController>> = {};

type DocAnswers = { mcq: Record<string, string[]>; cloze: Record<string, string> };

/** 补齐缺失的题型字段（默认两份空答案） */
function mergeAnswers(existing: { mcq?: Record<string, string[]>; cloze?: Record<string, string> } | undefined): DocAnswers {
  return { mcq: existing?.mcq ?? {}, cloze: existing?.cloze ?? {} };
}

const TAB_OF = { mcq: 'mcq', cloze: 'cloze', qa: 'qa' } as const;

export const useExercises = create<ExerciseState>()(
  persist(
    (set, get) => ({
      sets: {},
      answers: {},
      results: {},
      qa: {},
      activeTab: 'mcq',
      loading: {},
      errors: {},
      dirty: false,
      setActiveTab: (activeTab) => set({ activeTab }),
      setLoading: (t, v) => set((s) => ({ loading: { ...s.loading, [t]: v } })),
      setError: (k, v) => set((s) => ({ errors: { ...s.errors, [k]: v } })),
      generate: async (path, type, force) => {
        generateControllers[type]?.abort();
        const controller = new AbortController();
        generateControllers[type] = controller;
        get().setLoading(type, true);
        get().setError(type, null);
        try {
          const { exercise } = await api.generate(path, type, force, controller.signal);
          set((s) => ({
            sets: { ...s.sets, [type]: exercise },
            dirty: false,
            answers: { ...s.answers, [path]: mergeAnswers(s.answers[path]) },
            results: force ? { ...s.results, [path]: { ...s.results[path], [type]: undefined } } : s.results,
          }));
        } catch (err) {
          const e = err as ApiError;
          if (e.code !== 'cancelled') get().setError(type, e.message);
        } finally {
          if (generateControllers[type] === controller) {
            generateControllers[type] = undefined;
            get().setLoading(type, false);
          }
        }
      },
      cancelGenerate: (type) => {
        generateControllers[type]?.abort();
        generateControllers[type] = undefined;
        get().setLoading(type, false);
      },
      loadCached: async (path) => {
        for (const type of ['mcq', 'cloze', 'qa'] as const) {
          if (get().sets[type]) continue;
          try {
            const { exercise } = await api.cachedExercise(path, type);
            if (exercise) set((s) => ({ sets: { ...s.sets, [type]: exercise } }));
          } catch {
            /* 忽略：缓存不存在时按需生成 */
          }
        }
      },
      setAnswer: (path, type, id, value) =>
        set((s) => {
          const cur = mergeAnswers(s.answers[path]);
          return {
            answers: {
              ...s.answers,
              [path]: { ...cur, [type]: { ...cur[type], [id]: value } },
            },
          };
        }),
      setQaDraft: (path, qid, draft) =>
        set((s) => {
          const doc = s.qa[path] ?? {};
          return { qa: { ...s.qa, [path]: { ...doc, [qid]: { ...(doc[qid] ?? { draft: '' }), draft } } } };
        }),
      setQaEvaluation: (path, qid, evaluation) =>
        set((s) => {
          const doc = s.qa[path] ?? {};
          return { qa: { ...s.qa, [path]: { ...doc, [qid]: { draft: evaluation?.answer ?? doc[qid]?.draft ?? '', evaluation } } } };
        }),
      submit: async (path, type) => {
        const set_ = get().sets[type];
        if (!set_) return;
        const answers = mergeAnswers(get().answers[path]);
        try {
          if (type === 'mcq') {
            const { result } = await api.gradeMcq(set_.setId, answers.mcq);
            set((s) => ({ results: { ...s.results, [path]: { ...s.results[path], mcq: result } } }));
          } else {
            const { result } = await api.gradeCloze(set_.setId, answers.cloze);
            set((s) => ({ results: { ...s.results, [path]: { ...s.results[path], cloze: result } } }));
          }
        } catch (err) {
          get().setError(type, (err as ApiError).message);
        }
      },
      resetAnswers: (path, type) =>
        set((s) => ({
          answers: { ...s.answers, [path]: { ...mergeAnswers(s.answers[path]), [type]: {} } },
          results: { ...s.results, [path]: { ...s.results[path], [type]: undefined } },
        })),
      clear: () => {
        for (const t of ['mcq', 'cloze', 'qa'] as const) generateControllers[t]?.abort();
        // 题目不按文档分开存放，换文档时要丢掉。作答、判分和问答草稿按路径保留。
        set({ sets: {}, errors: {}, loading: {} });
      },
    }),
    {
      name: 'mdlearn:exercises',
      version: 1,
      partialize: (s) => ({ sets: s.sets, answers: s.answers, results: s.results, qa: s.qa, activeTab: s.activeTab }),
    },
  ),
);

export { TAB_OF };
