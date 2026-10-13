// DeepSeek API 服务模块：所有 AI 功能共用。
// 负责超时、取消、有限次数重试、JSON 解析、Schema 校验与语义校验。
import type { ZodType } from 'zod';
import type { AiConfig } from '../config';

export type AiErrorCode =
  | 'not_configured'
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'insufficient_balance'
  | 'rate_limited'
  | 'bad_request'
  | 'server_error'
  | 'empty_response'
  | 'truncated'
  | 'invalid_json'
  | 'invalid_schema'
  | 'invalid_content';

const MESSAGES: Record<AiErrorCode, string> = {
  not_configured: '尚未配置 DeepSeek API Key。请在项目根目录的 .env 中设置 DEEPSEEK_API_KEY 后重启服务。',
  cancelled: '请求已取消',
  timeout: 'AI 请求超时，请稍后重试',
  network: '无法连接 DeepSeek 服务，请检查网络或 DEEPSEEK_BASE_URL 配置',
  auth: 'DeepSeek API Key 无效或无权限，请检查 .env 配置',
  insufficient_balance: 'DeepSeek 账户余额不足',
  rate_limited: '请求过于频繁，已达到速率限制，请稍后重试',
  bad_request: 'DeepSeek 拒绝了请求（参数错误或模型名称无效）',
  server_error: 'DeepSeek 服务暂时不可用，请稍后重试',
  empty_response: 'AI 返回了空内容',
  truncated: 'AI 输出被截断（超出最大长度），请重试或调大 DEEPSEEK_MAX_TOKENS',
  invalid_json: 'AI 返回的内容不是有效的 JSON',
  invalid_schema: 'AI 返回的数据结构不符合要求',
  invalid_content: 'AI 返回的题目未通过校验',
};

const RETRYABLE = new Set<AiErrorCode>([
  'timeout',
  'network',
  'rate_limited',
  'server_error',
  'empty_response',
  'truncated',
  'invalid_json',
  'invalid_schema',
  'invalid_content',
]);

export class AiError extends Error {
  constructor(
    public code: AiErrorCode,
    public detail?: string,
  ) {
    super(MESSAGES[code]);
  }
  get retryable() {
    return RETRYABLE.has(this.code);
  }
  get httpStatus() {
    switch (this.code) {
      case 'not_configured':
        return 503;
      case 'cancelled':
        return 499;
      case 'timeout':
        return 504;
      case 'auth':
      case 'insufficient_balance':
      case 'rate_limited':
      case 'bad_request':
      case 'network':
      case 'server_error':
        return 502;
      default:
        return 502;
    }
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatJsonOptions<T> {
  messages: ChatMessage[];
  schema: ZodType<T>;
  /** 语义校验：返回修正后的数据；无法使用时抛出 AiError('invalid_content') 触发重试 */
  postValidate?: (data: T) => T;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  label?: string;
}

export interface ChatJsonResult<T> {
  data: T;
  attempts: number;
  usage?: unknown;
}

/** 从模型输出中提取 JSON：兼容 ```json 代码块与前后多余文字 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 继续尝试 */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* 继续尝试 */
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* 失败 */
    }
  }
  throw new AiError('invalid_json', trimmed.slice(0, 200));
}

function formatZodIssues(err: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AiError('cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AiError('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class DeepSeekClient {
  constructor(private config: AiConfig) {}

  get configured() {
    return this.config.apiKey.length > 0;
  }

  get modelSignature() {
    return `${this.config.baseUrl}|${this.config.model}|t=${this.config.temperature}`;
  }

  get model() {
    return this.config.model;
  }

  /** 单次请求：返回模型输出的文本 */
  private async requestOnce(messages: ChatMessage[], opts: { signal?: AbortSignal; maxTokens?: number; temperature?: number }): Promise<{ content: string; usage?: unknown }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      let res: Response;
      try {
        res = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            response_format: { type: 'json_object' },
            temperature: opts.temperature ?? this.config.temperature,
            max_tokens: opts.maxTokens ?? this.config.maxTokens,
            stream: false,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw new AiError('cancelled');
        if (timedOut) throw new AiError('timeout');
        throw new AiError('network', (err as Error).message);
      }

      let bodyText: string;
      try {
        bodyText = await res.text();
      } catch (err) {
        if (opts.signal?.aborted) throw new AiError('cancelled');
        if (timedOut) throw new AiError('timeout');
        throw new AiError('network', (err as Error).message);
      }

      if (!res.ok) {
        const detail = `HTTP ${res.status}: ${bodyText.slice(0, 300)}`;
        if (res.status === 401 || res.status === 403) throw new AiError('auth', detail);
        if (res.status === 402) throw new AiError('insufficient_balance', detail);
        if (res.status === 429) throw new AiError('rate_limited', detail);
        if (res.status >= 500) throw new AiError('server_error', detail);
        throw new AiError('bad_request', detail);
      }

      let payload: {
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
        usage?: unknown;
      };
      try {
        payload = JSON.parse(bodyText);
      } catch {
        throw new AiError('server_error', `响应不是 JSON：${bodyText.slice(0, 200)}`);
      }
      const choice = payload.choices?.[0];
      const content = choice?.message?.content ?? '';
      if (choice?.finish_reason === 'length') throw new AiError('truncated');
      if (!content.trim()) throw new AiError('empty_response');
      return { content, usage: payload.usage };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  async chatJson<T>(opts: ChatJsonOptions<T>): Promise<ChatJsonResult<T>> {
    if (!this.configured) throw new AiError('not_configured');
    const maxAttempts = 1 + this.config.maxRetries;
    let lastErr: AiError | null = null;
    let maxTokens = opts.maxTokens ?? this.config.maxTokens;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (opts.signal?.aborted) throw new AiError('cancelled');
      try {
        const { content, usage } = await this.requestOnce(opts.messages, { signal: opts.signal, maxTokens, temperature: opts.temperature });
        const json = extractJson(content);
        const parsed = opts.schema.safeParse(json);
        if (!parsed.success) throw new AiError('invalid_schema', formatZodIssues(parsed.error));
        const data = opts.postValidate ? opts.postValidate(parsed.data) : parsed.data;
        return { data, attempts: attempt, usage };
      } catch (err) {
        const e = err instanceof AiError ? err : new AiError('invalid_content', (err as Error).message);
        lastErr = e;
        console.warn(`[ai${opts.label ? ':' + opts.label : ''}] 第 ${attempt}/${maxAttempts} 次失败：${e.code} ${e.detail ?? ''}`);
        if (!e.retryable || attempt >= maxAttempts) break;
        if (e.code === 'truncated') maxTokens = Math.min(Math.round(maxTokens * 1.5), 16000);
        const backoff = (e.code === 'rate_limited' ? 2000 : 600) * 2 ** (attempt - 1) + Math.random() * 300;
        await sleep(backoff, opts.signal);
      }
    }
    throw lastErr ?? new AiError('server_error');
  }
}
