// 与后端交互的薄封装：所有 AI 请求都经由后端
import type {
  AppConfigResponse,
  ClozeGradeResult,
  DocResponse,
  DocScores,
  ExerciseType,
  LearnStatus,
  McqGradeResult,
  PublicExercise,
  QaEvaluation,
  TreeResponse,
} from '@shared/types';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public detail?: string,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new ApiError('cancelled', '请求已取消', 0);
    throw new ApiError('offline', '无法连接到本地服务，请确认后端已启动', 0);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; detail?: string } } | null)?.error;
    throw new ApiError(err?.code ?? 'unknown', err?.message ?? `请求失败（HTTP ${res.status}）`, res.status, err?.detail);
  }
  return body as T;
}

export const api = {
  config: () => request<AppConfigResponse>('/api/config'),
  tree: () => request<TreeResponse>('/api/tree'),
  doc: (path: string) => request<DocResponse>(`/api/doc?path=${encodeURIComponent(path)}`),
  scores: (path: string) => request<DocScores>(`/api/scores?path=${encodeURIComponent(path)}`),
  openDoc: (path: string) => request<{ path: string; status: LearnStatus }>('/api/progress/open', { method: 'POST', body: JSON.stringify({ path }) }),
  setStatus: (path: string, status: LearnStatus) =>
    request<{ path: string; status: LearnStatus }>('/api/progress', { method: 'PUT', body: JSON.stringify({ path, status }) }),
  cachedExercise: (path: string, type: ExerciseType) =>
    request<{ exercise: PublicExercise | null }>(`/api/exercises?path=${encodeURIComponent(path)}&type=${type}`),
  generate: (path: string, type: ExerciseType, force: boolean, signal?: AbortSignal) =>
    request<{ exercise: PublicExercise }>('/api/exercises/generate', { method: 'POST', body: JSON.stringify({ path, type, force }), signal }),
  gradeMcq: (setId: string, answers: Record<string, string[]>) =>
    request<{ result: McqGradeResult }>(`/api/exercises/${setId}/grade`, { method: 'POST', body: JSON.stringify({ type: 'mcq', answers }) }),
  gradeCloze: (setId: string, answers: Record<string, string>) =>
    request<{ result: ClozeGradeResult }>(`/api/exercises/${setId}/grade`, { method: 'POST', body: JSON.stringify({ type: 'cloze', answers }) }),
  evaluate: (setId: string, questionId: string, answer: string, signal?: AbortSignal) =>
    request<{ evaluation: QaEvaluation }>(`/api/exercises/${setId}/qa/${questionId}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
      signal,
    }),
};

export const assetUrl = (path: string) => `/api/asset?path=${encodeURIComponent(path)}`;
