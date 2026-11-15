import type { ZiweiChart } from '@/lib/ziwei/types';
import type { ChatMessage } from './openai-stream';
import { chartFingerprint } from '@/lib/brain/fingerprint';
import type { BrainPayload, BrainTopic } from '@/lib/brain/types';
import { asTopic, buildEvidenceContext, sanitizeBrainPayload } from '@/lib/brain/validate';

/** 只做结构校验：确认前端传的是完整的 ZiweiChart，避免把垃圾数据喂给模型 */
export function asChart(value: unknown): ZiweiChart | null {
  if (!value || typeof value !== 'object') return null;
  const chart = value as Partial<ZiweiChart>;
  if (!chart.birthInfo || typeof chart.birthInfo !== 'object') return null;
  if (!chart.lunarInfo || typeof chart.lunarInfo !== 'object') return null;
  if (!Array.isArray(chart.palaces) || chart.palaces.length !== 12) return null;
  if (typeof chart.mingGongBranch !== 'number') return null;
  return chart as ZiweiChart;
}

const MAX_MESSAGES = 30;
const MAX_CONTENT = 4000;

export interface MessageParseResult {
  messages: ChatMessage[];
  error?: string;
}

/**
 * 只接受 user / assistant 两种角色，客户端塞进来的 system 一律丢弃，
 * 保证 system prompt 只能由服务端决定（防提示词注入）。
 */
export function asMessages(value: unknown): MessageParseResult {
  if (!Array.isArray(value) || value.length === 0) return { messages: [], error: 'messages 不能为空' };
  if (value.length > MAX_MESSAGES) return { messages: [], error: `对话轮次过多（上限 ${MAX_MESSAGES} 条）` };

  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string') continue;
    const trimmed = content.trim();
    if (!trimmed) continue;
    messages.push({ role, content: trimmed.slice(0, MAX_CONTENT) });
  }

  if (!messages.length) return { messages: [], error: 'messages 中没有任何有效内容' };
  return { messages };
}

const MAX_EXTRACT_ANSWER = 8000;
const MAX_EXTRACT_QUESTION = 500;

export interface BrainExtractInput {
  chart: ZiweiChart;
  answer: string;
  question?: string;
}

/** 校验 /api/brain/extract 的请求体 */
export function asBrainExtractBody(value: unknown): { input?: BrainExtractInput; error?: string } {
  if (!value || typeof value !== 'object') return { error: '请求体不是对象' };
  const body = value as Record<string, unknown>;

  const chart = asChart(body.chart);
  if (!chart) return { error: '命盘数据不完整，请重新排盘后再试' };

  if (typeof body.answer !== 'string' || !body.answer.trim()) {
    return { error: '回答内容不能为空' };
  }
  const answer = body.answer.trim();
  if (answer.length > MAX_EXTRACT_ANSWER) {
    return { error: `回答内容过长（上限 ${MAX_EXTRACT_ANSWER} 字）` };
  }

  const question =
    typeof body.question === 'string' && body.question.trim()
      ? body.question.trim().slice(0, MAX_EXTRACT_QUESTION)
      : undefined;

  return { input: { chart, answer, question } };
}

/**
 * 校验客户端上传的档案投影。
 * - 指纹用服务端收到的 chart 重算，不信任客户端；
 * - 结构不合法时返回 null，解读照常进行（档案是可选增强）。
 */
export function asBrainPayload(value: unknown, chart: ZiweiChart): BrainPayload | null {
  return sanitizeBrainPayload(value, chartFingerprint(chart), buildEvidenceContext(chart));
}

export type InterpretTimeView = 'mingpan' | 'daxian' | 'liunian';

export interface BrainContextInput {
  topic?: BrainTopic;
  palace?: string;
  timeView?: InterpretTimeView;
  /** 仅 timeView === 'liunian' 时有意义 */
  year?: number;
}

/** 校验前端传来的主题/选中宫位/时间视图提示，非法值忽略 */
export function asBrainContext(value: unknown, chart: ZiweiChart): BrainContextInput | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const topic = asTopic(raw.topic) ?? undefined;

  let palace: string | undefined;
  if (typeof raw.palace === 'string') {
    const name = raw.palace.trim().slice(0, 20);
    if (name && chart.palaces.some(p => p.name === name || p.name === name.replace(/宫$/, ''))) {
      palace = name;
    }
  }

  const timeView =
    raw.timeView === 'mingpan' || raw.timeView === 'daxian' || raw.timeView === 'liunian'
      ? raw.timeView
      : undefined;

  let year: number | undefined;
  if (timeView === 'liunian' && Number.isInteger(raw.year)) {
    const parsed = Number(raw.year);
    if (parsed >= 1900 && parsed <= 2100) year = parsed;
  }

  if (!topic && !palace && !timeView) return null;
  const result: BrainContextInput = {};
  if (topic) result.topic = topic;
  if (palace) result.palace = palace;
  if (timeView) result.timeView = timeView;
  if (year !== undefined) result.year = year;
  return result;
}
