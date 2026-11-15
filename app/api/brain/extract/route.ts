import { resolveAiConfig } from '@/lib/ai/config';
import { completeChat } from '@/lib/ai/complete';
import { buildBrainExtractSystemPrompt, buildBrainExtractUserMessage } from '@/lib/ai/memory-prompt';
import { jsonError } from '@/lib/ai/sse';
import { clientKey, rateLimit } from '@/lib/ai/rate-limit';
import { asBrainExtractBody } from '@/lib/ai/validate';
import { detectPatterns } from '@/lib/ziwei/patterns';
import { buildEvidenceContext, parseBrainExtraction } from '@/lib/brain/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** 回答原文上限 8000 字，留出 JSON 包装与对话开销 */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * POST /api/brain/extract
 * body: { chart: ZiweiChart, answer: string, question?: string }
 * 返回: { memories: BrainMemoryDraft[], warnings: string[] }（非流式）
 */
export async function POST(request: Request) {
  const limit = rateLimit(`brain-extract:${clientKey(request)}`, 10, 60_000);
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

  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonError(413, '请求体过大');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, '请求体不是合法 JSON');
  }

  const parsedBody = asBrainExtractBody(body);
  if (!parsedBody.input) return jsonError(400, parsedBody.error ?? '参数不合法');
  const { chart, answer, question } = parsedBody.input;

  // patterns.ts 是 server-only，只能在这里算好名单交给纯函数校验层
  let patternNames: string[] | undefined;
  try {
    patternNames = detectPatterns(chart).map(pattern => pattern.name);
  } catch (error) {
    console.warn('[brain] pattern detection skipped:', error instanceof Error ? error.message : error);
  }

  const ctx = buildEvidenceContext(
    chart,
    patternNames ? new Set(patternNames) : undefined,
    answer,
  );
  const systemPrompt = buildBrainExtractSystemPrompt(chart, { patternNames });
  const userMessage = buildBrainExtractUserMessage(answer, question);

  try {
    let raw = await completeChat(
      config,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      { json: true, maxTokens: 2048, temperature: 0.1, thinking: 'off', signal: request.signal },
    );

    let result = parseBrainExtraction(raw, ctx);

    // 只修复一次：把不合法的输出作为 assistant 数据放回去，要求严格 JSON
    if (result.error) {
      raw = await completeChat(
        config,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
          { role: 'assistant', content: raw.slice(0, 4000) },
          { role: 'user', content: '上一次输出不是合法 JSON。请只输出符合 Schema 的 JSON，不要解释。' },
        ],
        { json: true, maxTokens: 2048, temperature: 0, thinking: 'off', signal: request.signal },
      );
      result = parseBrainExtraction(raw, ctx);
    }

    if (result.error) {
      return jsonError(422, '提炼失败，请重试或手动整理', result.error);
    }

    const memories = result.memories.map(draft => ({
      ...draft,
      source: { ...draft.source, question },
    }));

    return Response.json({ memories, warnings: result.warnings });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[brain] extract failed:', message.slice(0, 500));
    return jsonError(502, 'AI 提炼失败，请稍后重试');
  }
}
