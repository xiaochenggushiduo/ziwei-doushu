/**
 * 解读时选择要注入的档案。
 *
 * 策略：相关性打分 + 预算截断，不做全量注入。
 * 档案越多，prompt 越容易被无关旧结论带偏；只给当前问题最相关的少量条目。
 */

import type { ZiweiChart } from '@/lib/ziwei/types';
import {
  BRAIN_LIMITS,
  type BrainConfidence,
  type BrainStatus,
  type BrainTopic,
  type MemoryEvidence,
} from './types';

/** BrainMemory 与 BrainPayloadMemory 的公共可评分字段 */
export interface ScorableMemory {
  id: string;
  topic: BrainTopic;
  conclusion: string;
  evidence: MemoryEvidence[];
  confidence: BrainConfidence;
  status: BrainStatus;
  tags?: string[];
  updatedAt: number;
}

export interface InjectionContext {
  chart: ZiweiChart;
  /** 最后一次用户提问，用于关键词命中 */
  question?: string;
  /** 前端显式传入的主题（来自当前选中的主题按钮） */
  topic?: BrainTopic;
  /** 前端显式传入的选中宫位名 */
  palaceName?: string;
}

export interface InjectionResult<T extends ScorableMemory> {
  memories: T[];
  refuted: T[];
}

const TOPIC_KEYWORDS: Record<BrainTopic, string[]> = {
  personality: ['性格', '个性', '脾气', '自我', '命宫'],
  career: ['工作', '事业', '职业', '升职', '跳槽', '创业', '老板', '上司', '同事'],
  wealth: ['钱', '财', '收入', '投资', '理财', '积蓄', '买房', '负债'],
  love: ['感情', '恋爱', '结婚', '婚姻', '伴侣', '对象', '桃花', '分手', '离婚'],
  health: ['健康', '身体', '病', '疾厄', '睡眠', '医院'],
  family: ['父母', '兄弟', '子女', '家人', '六亲', '亲子'],
  study: ['学业', '考试', '读书', '学习', '考研', '留学'],
  travel: ['出行', '迁移', '外地', '出国', '搬迁', '旅行'],
  fortune: ['大限', '流年', '运势', '今年', '明年', '十年'],
  relationship: ['合盘', '相处', '匹配', '缘分', '两个人', '双方'],
  other: [],
};

export function inferTopic(text: string): BrainTopic | undefined {
  if (!text) return undefined;
  let best: { topic: BrainTopic; hits: number } | undefined;
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS) as [BrainTopic, string[]][]) {
    if (!keywords.length) continue;
    const hits = keywords.filter(keyword => text.includes(keyword)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { topic, hits };
  }
  return best?.topic;
}

function stripPalaceSuffix(name: string): string {
  return name.endsWith('宫') ? name.slice(0, -1) : name;
}

function samePalace(a: string, b: string): boolean {
  return a === b || stripPalaceSuffix(a) === stripPalaceSuffix(b);
}

function evidenceMentionsPalace(evidence: MemoryEvidence, palaceName: string): boolean {
  if (evidence.type === 'palace') return samePalace(evidence.name, palaceName);
  if (evidence.type === 'star') return !!evidence.palace && samePalace(evidence.palace, palaceName);
  return false;
}

function scoreMemory(
  memory: ScorableMemory,
  topic: BrainTopic | undefined,
  question: string,
  palaceName: string | undefined,
): number {
  let score = memory.status === 'confirmed' ? 30 : 10;
  score += memory.confidence === 'high' ? 6 : memory.confidence === 'medium' ? 3 : 0;

  if (topic && memory.topic === topic) score += 15;

  if (palaceName && memory.evidence.some(evidence => evidenceMentionsPalace(evidence, palaceName))) {
    score += 20;
  }

  for (const evidence of memory.evidence) {
    if (evidence.type === 'palace') {
      if (question && (question.includes(evidence.name) || question.includes(stripPalaceSuffix(evidence.name)))) {
        score += 8;
      }
    } else if (evidence.type === 'star') {
      if (question && question.includes(evidence.name)) score += 6;
    }
  }

  for (const tag of memory.tags ?? []) {
    if (tag && question.includes(tag)) score += 4;
  }

  const days = Math.max(0, (Date.now() - memory.updatedAt) / 86_400_000);
  score += Math.max(0, 10 - Math.floor(days / 30));

  return score;
}

function estimateLength(memory: ScorableMemory): number {
  const evidenceLength = memory.evidence.reduce((sum, evidence) => {
    if (evidence.type === 'palace' || evidence.type === 'star') return sum + evidence.name.length + 8;
    if (evidence.type === 'pattern') return sum + evidence.name.length + 6;
    return sum + evidence.quote.length + 6;
  }, 0);
  return memory.conclusion.length + evidenceLength + 12;
}

export function selectBrainForInjection<T extends ScorableMemory>(
  memories: T[],
  ctx: InjectionContext,
): InjectionResult<T> {
  const question = ctx.question ?? '';
  const topic = ctx.topic ?? inferTopic(question);
  const scored = memories.map(memory => ({
    memory,
    score: scoreMemory(memory, topic, question, ctx.palaceName),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.memory.updatedAt !== a.memory.updatedAt) return b.memory.updatedAt - a.memory.updatedAt;
    return a.memory.id.localeCompare(b.memory.id);
  });

  const selected: T[] = [];
  let usedChars = 0;
  for (const { memory } of scored) {
    if (memory.status === 'refuted') continue;
    if (selected.length >= BRAIN_LIMITS.maxInjectItems) break;
    const length = estimateLength(memory);
    if (usedChars + length > BRAIN_LIMITS.maxInjectChars) continue;
    selected.push(memory);
    usedChars += length;
  }

  const refuted = scored
    .filter(item => item.memory.status === 'refuted')
    .slice(0, BRAIN_LIMITS.maxRefutedItems)
    .map(item => item.memory);

  return { memories: selected, refuted };
}
