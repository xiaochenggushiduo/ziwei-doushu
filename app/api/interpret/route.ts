import { resolveAiConfig } from '@/lib/ai/config';
import { streamChat } from '@/lib/ai/openai-stream';
import { buildInterpretSystemPrompt } from '@/lib/ai/prompt';
import { createSseResponse, jsonError } from '@/lib/ai/sse';
import { clientKey, rateLimit } from '@/lib/ai/rate-limit';
import { asBrainContext, asBrainPayload, asChart, asMessages } from '@/lib/ai/validate';
import { selectBrainForInjection } from '@/lib/brain/inject';
import { formatSubjectLabel } from '@/lib/brain/fingerprint';
import type { BrainPromptSection } from '@/lib/brain/format';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/interpret
 * body: { chart: ZiweiChart, messages: {role,content}[], brain?, context? }
 * 返回: text/event-stream，每行 `data: {"delta":{"text":"..."}}`，以 `data: [DONE]` 结束
 */
export async function POST(request: Request) {
  const limit = rateLimit(`interpret:${clientKey(request)}`, 20, 60_000);
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

  const payload = body as {
    chart?: unknown;
    messages?: unknown;
    brain?: unknown;
    context?: unknown;
  };
  const chart = asChart(payload.chart);
  if (!chart) return jsonError(400, '命盘数据不完整，请重新排盘后再试');

  const parsed = asMessages(payload.messages);
  if (parsed.error) return jsonError(400, parsed.error);

  // 档案是可选增强：任何非法/过期内容都静默忽略，不阻断正常解读
  const brainPayload = asBrainPayload(payload.brain, chart);
  const brainContext = asBrainContext(payload.context, chart);

  let brainSection: BrainPromptSection | undefined;
  if (brainPayload) {
    const lastUser = [...parsed.messages].reverse().find(message => message.role === 'user');
    const injected = selectBrainForInjection(brainPayload.memories, {
      chart,
      question: lastUser?.content,
      topic: brainContext?.topic,
      palaceName: brainContext?.palace,
    });
    if (injected.memories.length || injected.refuted.length) {
      brainSection = {
        subjectLabel: formatSubjectLabel(chart),
        memories: injected.memories,
        refuted: injected.refuted,
      };
    }
  }

  const timeContext = brainContext?.timeView
    ? { timeView: brainContext.timeView, year: brainContext.year }
    : undefined;

  const messages = [
    { role: 'system' as const, content: buildInterpretSystemPrompt(chart, brainSection, timeContext) },
    ...parsed.messages,
  ];

  return createSseResponse(streamChat(config, messages, { signal: request.signal }), request);
}
