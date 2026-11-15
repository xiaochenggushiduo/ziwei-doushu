import { resolveAiConfig } from '@/lib/ai/config';
import { streamChat } from '@/lib/ai/openai-stream';
import { buildHemingSystemPrompt } from '@/lib/ai/prompt';
import { createSseResponse, jsonError } from '@/lib/ai/sse';
import { clientKey, rateLimit } from '@/lib/ai/rate-limit';
import { asChart } from '@/lib/ai/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_QUESTION = 500;

/**
 * POST /api/heming
 * body: { chartA: ZiweiChart, chartB: ZiweiChart, question?: string }
 * 返回: text/event-stream（与 /api/interpret 同格式）
 */
export async function POST(request: Request) {
  const limit = rateLimit(`heming:${clientKey(request)}`, 10, 60_000);
  if (!limit.ok) {
    return jsonError(429, `请求过于频繁，请 ${limit.retryAfterSeconds} 秒后再试`);
  }

  const config = resolveAiConfig();
  if (!config) {
    return jsonError(
      503,
      'AI 未配置',
      '请在 .env.local 里设置 AI_PROVIDER 与对应的 API Key（如 DEEPSEEK_API_KEY），改完需重启 dev server。',
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, '请求体不是合法 JSON');
  }

  const payload = body as { chartA?: unknown; chartB?: unknown; question?: unknown };
  const chartA = asChart(payload.chartA);
  const chartB = asChart(payload.chartB);
  if (!chartA || !chartB) return jsonError(400, '双方命盘数据不完整，请重新起盘后再试');

  const question =
    typeof payload.question === 'string' && payload.question.trim()
      ? payload.question.trim().slice(0, MAX_QUESTION)
      : null;

  const messages = [
    { role: 'system' as const, content: buildHemingSystemPrompt(chartA, chartB) },
    {
      role: 'user' as const,
      content: question ? `请针对这个问题做合盘分析：${question}` : '请做一次完整的合盘分析。',
    },
  ];

  return createSseResponse(streamChat(config, messages, { signal: request.signal }), request);
}
