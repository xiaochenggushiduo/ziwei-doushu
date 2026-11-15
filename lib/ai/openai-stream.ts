import type { AiConfig } from './config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamOptions {
  /** 单次回答的最大 token 数 */
  maxTokens?: number;
  temperature?: number;
  /** 是否让模型先思考（默认跟随 AiConfig.disableThinking） */
  thinking?: 'on' | 'off';
  /** 客户端断开时用于中止上游请求 */
  signal?: AbortSignal;
}

/**
 * 调用 OpenAI 兼容的 /chat/completions 流式接口，逐段吐出文本增量。
 * 上游返回的 `data: {...}` 行不转发，只把 delta.content 交出去，避免协议泄漏给前端。
 */
export async function* streamChat(
  config: AiConfig,
  messages: ChatMessage[],
  options: StreamOptions = {},
): AsyncGenerator<string, void, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? config.maxTokens,
  };
  // DeepSeek V4 的思考 token 也计入 max_tokens，长 prompt 极易导致正文为空
  const thinkingMode = options.thinking ?? (config.disableThinking ? 'off' : 'on');
  if (config.provider === 'deepseek') {
    body.thinking = { type: thinkingMode === 'off' ? 'disabled' : 'enabled' };
  }

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new UpstreamError(res.status, detail.slice(0, 500) || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let yielded = 0;
  let reasoningChars = 0;
  let finishReason: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件；只处理完整的行，残留半行留在 buffer 里
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          newlineIndex = -1;
          buffer = '';
          break;
        }

        try {
          const json = JSON.parse(payload) as {
            choices?: {
              delta?: { content?: string | null; reasoning_content?: string | null };
              finish_reason?: string | null;
            }[];
          };
          const choice = json.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (choice?.delta?.reasoning_content) reasoningChars += choice.delta.reasoning_content.length;
          const text = choice?.delta?.content;
          if (text) {
            yielded += text.length;
            yield text;
          }
        } catch {
          // 上游偶发的心跳/非 JSON 行，忽略即可
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (yielded === 0) {
    const hint =
      finishReason === 'length'
        ? '模型把 token 预算用在了思考过程上，正文没来得及输出。可在 .env.local 调大 AI_MAX_TOKENS，或保持 AI_THINKING 默认关闭。'
        : '模型这次没有返回正文，请重试；若持续出现，可换 AI_MODEL（如 deepseek-flash）试试。';
    console.warn(`[ai] empty answer: finish=${finishReason}, reasoningChars=${reasoningChars}`);
    yield `（${hint}）`;
  }
}

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Upstream ${status}: ${detail}`);
    this.name = 'UpstreamError';
  }
}
