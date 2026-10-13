import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface AiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  maxTokens: number;
  temperature: number;
}

export interface AppConfig {
  port: number;
  learnDir: string;
  promptsDir: string;
  cacheDir: string;
  synonymsFile: string;
  ai: AiConfig;
  /** 生产模式下由后端托管前端静态资源 */
  staticDir: string | null;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback;
}

export function loadConfig(overrides: Partial<Omit<AppConfig, 'ai'>> & { ai?: Partial<AiConfig> } = {}): AppConfig {
  dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });
  const env = process.env;
  const abs = (p: string) => path.resolve(PROJECT_ROOT, p);
  const base: AppConfig = {
    port: num(env.PORT, 3001),
    learnDir: abs(env.LEARN_DIR || 'learn'),
    promptsDir: abs(env.PROMPTS_DIR || 'prompts'),
    cacheDir: abs(env.CACHE_DIR || '.cache'),
    synonymsFile: abs(env.SYNONYMS_FILE || 'config/synonyms.json'),
    staticDir: env.NODE_ENV === 'production' ? abs('dist/client') : null,
    ai: {
      apiKey: (env.DEEPSEEK_API_KEY || '').trim(),
      baseUrl: (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
      model: env.DEEPSEEK_MODEL || 'deepseek-chat',
      timeoutMs: num(env.DEEPSEEK_TIMEOUT_MS, 120_000),
      maxRetries: Math.max(0, Math.min(5, num(env.DEEPSEEK_MAX_RETRIES, 2))),
      maxTokens: num(env.DEEPSEEK_MAX_TOKENS, 8000),
      temperature: num(env.DEEPSEEK_TEMPERATURE, 0.3),
    },
  };
  return { ...base, ...overrides, ai: { ...base.ai, ...(overrides.ai ?? {}) } };
}
