import type { AiConfig } from './config';
import { UpstreamError, type ChatMessage } from './openai-stream';

export interface CompleteOptions {
  /** 单次回答的最大 token 数，默认 2048 */
  maxTokens?: number;
  /** 默认 0.1：档案提炼需要稳定输出 */
  temperature?: number;
  /** 是否让模型先思考（默认跟随 AiConfig.disableThinking） */
  thinking?: 'on' | 'off';
  /** 请求 OpenAI 兼容的 JSON 模式；供应商不支持时自动降级重试一次 */
  json?: boolean;
  signal?: AbortSignal;
}

/** 非流式补全：用于需要完整 JSON 的档案提炼等场景 */
export async function completeChat(
  config: AiConfig,
  messages: ChatMessage[],
  options: CompleteOptions = {},
): Promise<string> {
  const first = await requestOnce(config, messages, options, options.json === true);
  if (first.text !== null) return first.text;

  // 部分 OpenAI 兼容网关不接受 response_format，去掉后重试一次
  if (options.json && (first.status === 400 || first.status === 422)) {
    const retry = await requestOnce(config, messages, options, false);
    if (retry.text !== null) return retry.text;
    throw retry.error ?? new UpstreamError(retry.status ?? 502, 'completion failed');
  }

  throw first.error ?? new UpstreamError(first.status ?? 502, 'completion failed');
}

interface AttemptResult {
  text: string | null;
  status?: number;
  error?: UpstreamError;
}

async function requestOnce(
  config: AiConfig,
  messages: ChatMessage[],
  options: CompleteOptions,
  json: boolean,
): Promise<AttemptResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
    temperature: options.temperature ?? 0.1,
    max_tokens: options.maxTokens ?? 2048,
  };

  const thinkingMode = options.thinking ?? (config.disableThinking ? 'off' : 'on');
  if (config.provider === 'deepseek') {
    body.thinking = { type: thinkingMode === 'off' ? 'disabled' : 'enabled' };
  }
  if (json) body.response_format = { type: 'json_object' };

  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: null, status: 502, error: new UpstreamError(502, message.slice(0, 500)) };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return {
      text: null,
      status: res.status,
      error: new UpstreamError(res.status, detail.slice(0, 500) || res.statusText),
    };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { text: null, status: 502, error: new UpstreamError(502, '返回内容不是 JSON') };
  }

  const content = (payload as {
    choices?: { message?: { content?: unknown } }[];
  })?.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    return { text: null, status: 502, error: new UpstreamError(502, '模型没有返回正文') };
  }

  return { text: content };
}
