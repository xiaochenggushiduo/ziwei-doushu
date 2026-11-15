/**
 * AI 供应商配置解析
 *
 * 支持任意 OpenAI 兼容协议的服务（DeepSeek / MiMo / OpenAI / 自建网关）。
 * 优先级：通用变量（AI_*） > 供应商专属变量（DEEPSEEK_* / MIMO_* / OPENAI_*） > 内置默认值。
 *
 * 例：
 *   AI_PROVIDER=deepseek
 *   DEEPSEEK_API_KEY=sk-xxx
 *   DEEPSEEK_MODEL=deepseek-v4-pro      # 可选，不填用默认
 *
 * 换别家只用改 AI_PROVIDER 与对应前缀的 API_KEY，无需改代码。
 */

export interface AiConfig {
  /** 供应商标识（小写），仅用于日志与提示文案 */
  provider: string;
  /** OpenAI 兼容根地址，不含 /chat/completions */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次回答的 max_tokens */
  maxTokens: number;
  /**
   * 是否向 DeepSeek 发送 `thinking: { type: 'disabled' }`。
   * DeepSeek V4 默认会先long思考，思考 token 同样计入 max_tokens，
   * 长 prompt（如合盘）时常常把预算吃光导致正文为空 —— 默认关掉，可用 AI_THINKING=on 打开。
   */
  disableThinking: boolean;
}

type Env = Record<string, string | undefined>;

const DEFAULT_BASE_URL: Record<string, string> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  mimo: 'https://api.mimo.ai/v1',
};

const DEFAULT_MODEL: Record<string, string> = {
  deepseek: 'deepseek-v4-pro',
  openai: 'gpt-4o-mini',
  mimo: 'mimo-7b-rl',
};

function pick(env: Env, keys: string[]): string | undefined {
  for (const key of keys) {
    if (!key) continue;
    const value = env[key];
    if (value && value.trim()) return value.trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/** 解析当前环境的 AI 配置；缺少 API Key 时返回 null（调用方据此给出明确提示） */
export function resolveAiConfig(env: Env = process.env): AiConfig | null {
  const provider = (pick(env, ['AI_PROVIDER']) ?? 'deepseek').toLowerCase();
  const prefix = provider.toUpperCase();

  const apiKey = pick(env, ['AI_API_KEY', `${prefix}_API_KEY`]);
  if (!apiKey) return null;

  const baseUrl = pick(env, ['AI_BASE_URL', `${prefix}_BASE_URL`]) ?? DEFAULT_BASE_URL[provider];
  if (!baseUrl) return null;

  const model = pick(env, ['AI_MODEL', `${prefix}_MODEL`]) ?? DEFAULT_MODEL[provider];
  if (!model) return null;

  const maxTokens = Number(pick(env, ['AI_MAX_TOKENS']) ?? 8192);
  const thinkingFlag = pick(env, ['AI_THINKING'])?.toLowerCase();
  const disableThinking =
    thinkingFlag === 'off' || thinkingFlag === 'disabled'
      ? true
      : thinkingFlag === 'on' || thinkingFlag === 'enabled'
        ? false
        : provider === 'deepseek';

  return {
    provider,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, 32000) : 8192,
    disableThinking,
  };
}
