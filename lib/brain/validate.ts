/**
 * brain 纯函数校验层。
 *
 * 这个文件不 import 任何 server-only 的东西，也不访问 DOM：
 * - 前端用它清洗 localStorage 读出的数据；
 * - 服务端用它校验客户端传来的档案与模型提炼结果。
 *
 * 所有函数都「显式重建」对象，绝不把外部对象展开后直接使用。
 */

import type { ZiweiChart } from '@/lib/ziwei/types';
import {
  BRAIN_EXPORT_KIND,
  BRAIN_LIMITS,
  BRAIN_SCHEMA_VERSION,
  BRAIN_TOPICS,
  type BrainConfidence,
  type BrainMemory,
  type BrainMemoryDraft,
  type BrainPayload,
  type BrainPayloadMemory,
  type BrainStatus,
  type BrainStore,
  type BrainSubject,
  type BrainSubjectForm,
  type BrainTopic,
  type MemoryEvidence,
  type SiHuaChar,
} from './types';

// ─── 基础清洗 ────────────────────────────────────────────────

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F]/g;

export function cleanText(value: unknown, maxLen: number, singleLine = true): string {
  if (typeof value !== 'string') return '';
  let s = value.replace(CONTROL_CHARS, ' ');
  s = singleLine ? s.replace(/\s+/g, ' ').trim() : s.replace(/\r\n?/g, '\n').trim();
  return s.slice(0, maxLen);
}

/** 结论/文本去重用的归一化：去掉空白、markdown 标记与常见标点 */
export function normalizeForDedupe(value: string): string {
  return value
    .replace(/[\s*#>`~_\-—–·,，。！!？?；;：:、"“”'‘’（）()\[\]【】]/g, '')
    .toLowerCase();
}

/** 原文引用匹配用：只去空白与 markdown 标记，保留标点 */
function normalizeQuote(value: string): string {
  return value.replace(/[\s*#>`~_]/g, '');
}

// ─── 枚举映射 ────────────────────────────────────────────────

const TOPIC_ALIASES: Record<string, BrainTopic> = {
  性格: 'personality',
  个性: 'personality',
  事业: 'career',
  工作: 'career',
  职业: 'career',
  财运: 'wealth',
  财富: 'wealth',
  感情: 'love',
  婚姻: 'love',
  恋爱: 'love',
  健康: 'health',
  六亲: 'family',
  家庭: 'family',
  家人: 'family',
  学业: 'study',
  学习: 'study',
  迁移: 'travel',
  出行: 'travel',
  大限流年: 'fortune',
  运势: 'fortune',
  大限: 'fortune',
  流年: 'fortune',
  关系: 'relationship',
  合盘: 'relationship',
  其他: 'other',
};

export function asTopic(value: unknown): BrainTopic | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if ((BRAIN_TOPICS as string[]).includes(v)) return v as BrainTopic;
  return TOPIC_ALIASES[v] ?? null;
}

export function asConfidence(value: unknown): BrainConfidence | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  if (v === '高' || v === '高置信') return 'high';
  if (v === '中' || v === '中置信') return 'medium';
  if (v === '低' || v === '低置信') return 'low';
  return null;
}

export function asStatus(value: unknown): BrainStatus | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'unverified' || v === 'confirmed' || v === 'refuted') return v;
  if (v === '未验证') return 'unverified';
  if (v === '已确认' || v === '确认') return 'confirmed';
  if (v === '已推翻' || v === '推翻') return 'refuted';
  return null;
}

function asSiHua(value: unknown): SiHuaChar | undefined {
  return value === '禄' || value === '权' || value === '科' || value === '忌' ? value : undefined;
}

// ─── 证据上下文与校验 ────────────────────────────────────────

/** 宫名归一化：盘内数据用「夫妻」这类短名，而模型常写「夫妻宫」，统一去掉尾部「宫」再比对 */
function normalizePalaceName(name: string): string {
  return name.endsWith('宫') ? name.slice(0, -1) : name;
}

export interface EvidenceContext {
  /** 当前盘十二宫宫名（已归一化） */
  palaceNames: Set<string>;
  /** 星名 -> 它出现过的宫名（已归一化；含空宫借对宫借来的主星） */
  starPalaces: Map<string, Set<string>>;
  /** 星名 -> 盘上出现过的四化 */
  starSiHua: Map<string, Set<SiHuaChar>>;
  /** 格局名；不传表示不校验 pattern 类型 */
  patternNames?: Set<string>;
  /** 提炼时的解读原文；不传表示不校验 answer 引用 */
  answerText?: string;
}

/** 从命盘收集可引用的宫位/星曜名称；patterns 由调用方算好传入（本文件不 import patterns.ts） */
export function buildEvidenceContext(
  chart: Pick<ZiweiChart, 'palaces'>,
  patternNames?: Set<string>,
  answerText?: string,
): EvidenceContext {
  const palaceNames = new Set<string>();
  const starPalaces = new Map<string, Set<string>>();
  const starSiHua = new Map<string, Set<SiHuaChar>>();

  const add = (star: string, palace: string) => {
    if (!star) return;
    let set = starPalaces.get(star);
    if (!set) {
      set = new Set<string>();
      starPalaces.set(star, set);
    }
    set.add(normalizePalaceName(palace));
  };

  for (const palace of chart.palaces) {
    palaceNames.add(normalizePalaceName(palace.name));
    for (const star of palace.stars) {
      add(star.name, palace.name);
      if (star.siHua) {
        let set = starSiHua.get(star.name);
        if (!set) {
          set = new Set<SiHuaChar>();
          starSiHua.set(star.name, set);
        }
        set.add(star.siHua);
      }
    }
    for (const borrowed of palace.borrowedStars ?? []) add(borrowed, palace.name);
    for (const self of palace.selfSihua ?? []) {
      let set = starSiHua.get(self.starName);
      if (!set) {
        set = new Set<SiHuaChar>();
        starSiHua.set(self.starName, set);
      }
      set.add(self.siHua);
    }
  }

  return { palaceNames, starPalaces, starSiHua, patternNames, answerText };
}

export function sanitizeEvidence(item: unknown, ctx?: EvidenceContext): MemoryEvidence | null {
  if (!item || typeof item !== 'object') return null;
  const raw = item as Record<string, unknown>;

  if (raw.type === 'palace') {
    const name = cleanText(raw.name, 20);
    if (!name) return null;
    if (ctx && !ctx.palaceNames.has(normalizePalaceName(name))) return null;
    return { type: 'palace', name };
  }

  if (raw.type === 'star') {
    const name = cleanText(raw.name, 20);
    if (!name) return null;
    const palace = cleanText(raw.palace, 20) || undefined;
    const siHua = asSiHua(raw.siHua);
    if (ctx) {
      const palaces = ctx.starPalaces.get(name);
      if (!palaces) return null;
      if (palace && !palaces.has(normalizePalaceName(palace))) return null;
      if (siHua && !ctx.starSiHua.get(name)?.has(siHua)) return null;
    }
    const evidence: MemoryEvidence = { type: 'star', name };
    if (palace) evidence.palace = palace;
    if (siHua) evidence.siHua = siHua;
    return evidence;
  }

  if (raw.type === 'pattern') {
    const name = cleanText(raw.name, 20);
    if (!name) return null;
    if (ctx?.patternNames && !ctx.patternNames.has(name)) return null;
    return { type: 'pattern', name };
  }

  if (raw.type === 'answer') {
    const quote = cleanText(raw.quote, BRAIN_LIMITS.maxQuoteChars);
    if (!quote) return null;
    if (ctx?.answerText) {
      if (!normalizeQuote(ctx.answerText).includes(normalizeQuote(quote))) return null;
    }
    return { type: 'answer', quote };
  }

  return null;
}

export function sanitizeEvidenceList(value: unknown, ctx?: EvidenceContext): MemoryEvidence[] {
  if (!Array.isArray(value)) return [];
  const out: MemoryEvidence[] = [];
  for (const item of value.slice(0, BRAIN_LIMITS.maxEvidenceItems)) {
    const evidence = sanitizeEvidence(item, ctx);
    if (evidence) out.push(evidence);
  }
  return out;
}

// ─── 内存中的记忆条目 ────────────────────────────────────────

export interface SanitizeResult<T> {
  value: T | null;
  warnings: string[];
}

export function sanitizeMemory(
  value: unknown,
  fallbackFingerprint?: string,
  ctx?: EvidenceContext,
): SanitizeResult<BrainMemory> {
  const warnings: string[] = [];
  if (!value || typeof value !== 'object') return { value: null, warnings: ['条目不是对象'] };
  const raw = value as Record<string, unknown>;

  const fingerprint = cleanText(raw.fingerprint, 64) || fallbackFingerprint || '';
  if (!fingerprint) return { value: null, warnings: ['缺少命盘指纹'] };

  const topic = asTopic(raw.topic);
  if (!topic) return { value: null, warnings: ['主题不合法'] };

  const conclusion = cleanText(raw.conclusion, BRAIN_LIMITS.maxConclusionChars);
  if (!conclusion) return { value: null, warnings: ['结论为空'] };

  const evidence = sanitizeEvidenceList(raw.evidence, ctx);
  if (!evidence.length) return { value: null, warnings: ['没有可核对的依据'] };

  const confidence = asConfidence(raw.confidence) ?? 'low';
  const status = asStatus(raw.status) ?? 'unverified';

  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .slice(0, BRAIN_LIMITS.maxTags)
        .map(t => cleanText(t, BRAIN_LIMITS.maxTagChars))
        .filter(Boolean)
    : [];

  const sourceRaw = raw.source && typeof raw.source === 'object' ? (raw.source as Record<string, unknown>) : {};
  const kind = sourceRaw.kind === 'manual' ? 'manual' : 'interpret';
  const question = cleanText(sourceRaw.question, BRAIN_LIMITS.maxQuestionChars) || undefined;
  const answerExcerpt =
    cleanText(sourceRaw.answerExcerpt, BRAIN_LIMITS.maxAnswerExcerptChars) || undefined;

  const id =
    cleanText(raw.id, 64) ||
    `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const createdAt = Number.isFinite(raw.createdAt) && Number(raw.createdAt) > 0 ? Number(raw.createdAt) : now;
  const updatedAt = Number.isFinite(raw.updatedAt) && Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : createdAt;

  const memory: BrainMemory = {
    id,
    fingerprint,
    topic,
    conclusion,
    evidence,
    confidence,
    status,
    tags,
    source: { kind },
    createdAt,
    updatedAt,
  };
  if (question) memory.source.question = question;
  if (answerExcerpt) memory.source.answerExcerpt = answerExcerpt;

  return { value: memory, warnings };
}

// ─── 提炼结果解析 ────────────────────────────────────────────

export interface ExtractionParseResult {
  memories: BrainMemoryDraft[];
  warnings: string[];
  error?: string;
}

function stripJsonWrapper(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  // 去掉 markdown 代码围栏
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

/**
 * 解析模型返回的 JSON，并用 EvidenceContext 做 grounding：
 * - 宫位/星曜/格局必须真实存在于当前盘；
 * - answer 引用必须是解读原文的子串；
 * - 一条记忆的所有依据都无效时整条丢弃。
 */
export function parseBrainExtraction(
  raw: string,
  ctx: EvidenceContext,
): ExtractionParseResult {
  const warnings: string[] = [];
  const json = stripJsonWrapper(raw);
  if (!json) return { memories: [], warnings, error: '模型没有返回 JSON' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { memories: [], warnings, error: 'JSON 解析失败' };
  }

  const list =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { memories?: unknown }).memories)
      ? ((parsed as { memories: unknown[] }).memories)
      : null;
  if (!list) return { memories: [], warnings, error: 'JSON 缺少 memories 数组' };

  const memories: BrainMemoryDraft[] = [];
  const seen = new Set<string>();

  for (const item of list.slice(0, BRAIN_LIMITS.maxExtractItems)) {
    if (!item || typeof item !== 'object') continue;
    const raw2 = item as Record<string, unknown>;

    const topic = asTopic(raw2.topic);
    if (!topic) {
      warnings.push('丢弃一条主题不合法的记忆');
      continue;
    }
    const conclusion = cleanText(raw2.conclusion, BRAIN_LIMITS.maxConclusionChars);
    if (!conclusion) {
      warnings.push('丢弃一条结论为空的记忆');
      continue;
    }

    const evidence = sanitizeEvidenceList(raw2.evidence, ctx);
    if (!evidence.length) {
      warnings.push(`“${conclusion.slice(0, 20)}…”没有任何可核对的盘面/原文依据，已丢弃`);
      continue;
    }

    const key = normalizeForDedupe(conclusion);
    if (seen.has(key)) continue;
    seen.add(key);

    memories.push({
      topic,
      conclusion,
      evidence,
      confidence: asConfidence(raw2.confidence) ?? 'low',
      source: {
        kind: 'interpret',
        answerExcerpt: cleanText(ctx.answerText ?? '', BRAIN_LIMITS.maxAnswerExcerptChars),
      },
    });
  }

  return { memories, warnings };
}

// ─── 服务端 payload 校验 ─────────────────────────────────────

export function sanitizePayloadMemory(
  value: unknown,
  ctx?: EvidenceContext,
): BrainPayloadMemory | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const id = cleanText(raw.id, 64);
  const topic = asTopic(raw.topic);
  const conclusion = cleanText(raw.conclusion, BRAIN_LIMITS.maxConclusionChars);
  const evidence = sanitizeEvidenceList(raw.evidence, ctx);
  const confidence = asConfidence(raw.confidence);
  const status = asStatus(raw.status);
  if (!id || !topic || !conclusion || !evidence.length || !confidence || !status) return null;

  return {
    id,
    topic,
    conclusion,
    evidence,
    confidence,
    status,
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : Date.now(),
  };
}

/**
 * 校验客户端上传的档案投影。
 * - 指纹必须与服务端重算的值严格一致；
 * - 非法条目静默丢弃；全部非法时返回 null（调用方按“无档案”处理）。
 */
export function sanitizeBrainPayload(
  value: unknown,
  fingerprint: string,
  ctx?: EvidenceContext,
): BrainPayload | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.fingerprint !== fingerprint) return null;
  if (!Array.isArray(raw.memories)) return null;

  const memories: BrainPayloadMemory[] = [];
  const seen = new Set<string>();
  for (const item of raw.memories.slice(0, BRAIN_LIMITS.maxPayloadMemories)) {
    const memory = sanitizePayloadMemory(item, ctx);
    if (!memory) continue;
    const key = normalizeForDedupe(memory.conclusion);
    if (seen.has(key)) continue;
    seen.add(key);
    memories.push(memory);
  }

  if (!memories.length) return null;
  if (JSON.stringify(memories).length > BRAIN_LIMITS.maxPayloadChars) return null;
  return { fingerprint, memories };
}

// ─── 本地 store 清洗 / 导出导入 ─────────────────────────────

export function createEmptyStore(): BrainStore {
  return {
    version: BRAIN_SCHEMA_VERSION,
    updatedAt: 0,
    subjects: {},
    memories: [],
    settings: { injectEnabled: true },
  };
}

export interface StoreParseResult {
  store: BrainStore;
  warnings: string[];
  /** false 表示数据由更高版本写入，调用方不应覆盖 */
  compatible: boolean;
}

function sanitizeSubjectForm(value: unknown): BrainSubjectForm | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const year = cleanText(raw.year, 4);
  const month = cleanText(raw.month, 2);
  const day = cleanText(raw.day, 2);
  if (!year || !month || !day) return undefined;
  return {
    name: cleanText(raw.name, 40),
    year,
    month,
    day,
    clockHour: cleanText(raw.clockHour, 2),
    clockMinute: cleanText(raw.clockMinute, 2),
    unknownTime: raw.unknownTime === true,
    province: cleanText(raw.province, 20),
    city: cleanText(raw.city, 20),
    longitude: Number.isFinite(raw.longitude) ? Number(raw.longitude) : 120,
    gender: raw.gender === 'female' ? 'female' : 'male',
  };
}

function sanitizeSubject(value: unknown, fingerprint: string): BrainSubject | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const now = Date.now();
  const label = cleanText(raw.label, 80) || fingerprint;
  const subject: BrainSubject = {
    fingerprint,
    label,
    createdAt: Number.isFinite(raw.createdAt) && Number(raw.createdAt) > 0 ? Number(raw.createdAt) : now,
    updatedAt: Number.isFinite(raw.updatedAt) && Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : now,
  };
  const form = sanitizeSubjectForm(raw.form);
  if (form) subject.form = form;
  return subject;
}

export function sanitizeBrainStore(value: unknown): StoreParseResult {
  const warnings: string[] = [];
  if (!value || typeof value !== 'object') {
    return { store: createEmptyStore(), warnings: ['档案数据不是对象'], compatible: true };
  }
  const raw = value as Record<string, unknown>;
  const version = Number(raw.version);

  if (Number.isFinite(version) && version > BRAIN_SCHEMA_VERSION) {
    return {
      store: createEmptyStore(),
      warnings: ['档案由更高版本写入，已停止读取以免覆盖，请升级应用或先导出备份'],
      compatible: false,
    };
  }

  const store = createEmptyStore();
  store.updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : 0;

  if (raw.settings && typeof raw.settings === 'object') {
    const settings = raw.settings as Record<string, unknown>;
    store.settings.injectEnabled = settings.injectEnabled !== false;
  }

  if (raw.subjects && typeof raw.subjects === 'object' && !Array.isArray(raw.subjects)) {
    for (const [fingerprint, subject] of Object.entries(raw.subjects as Record<string, unknown>)) {
      const cleanFp = cleanText(fingerprint, 64);
      if (!cleanFp) continue;
      const cleanSubject = sanitizeSubject(subject, cleanFp);
      if (cleanSubject) store.subjects[cleanFp] = cleanSubject;
    }
  }

  if (Array.isArray(raw.memories)) {
    for (const item of raw.memories.slice(0, BRAIN_LIMITS.maxMemoriesTotal)) {
      const result = sanitizeMemory(item);
      if (result.value) store.memories.push(result.value);
      else warnings.push(...result.warnings);
    }
  }

  // 按指纹限条：保留更新的
  const perSubject = new Map<string, BrainMemory[]>();
  for (const memory of store.memories) {
    const list = perSubject.get(memory.fingerprint) ?? [];
    list.push(memory);
    perSubject.set(memory.fingerprint, list);
  }
  const kept: BrainMemory[] = [];
  for (const list of perSubject.values()) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    kept.push(...list.slice(0, BRAIN_LIMITS.maxMemoriesPerSubject));
  }
  kept.sort((a, b) => b.updatedAt - a.updatedAt);
  store.memories = kept.slice(0, BRAIN_LIMITS.maxMemoriesTotal);

  return { store, warnings, compatible: true };
}

export interface BrainExport {
  kind: typeof BRAIN_EXPORT_KIND;
  version: typeof BRAIN_SCHEMA_VERSION;
  exportedAt: number;
  store: BrainStore;
}

export function createBrainExport(store: BrainStore): BrainExport {
  return {
    kind: BRAIN_EXPORT_KIND,
    version: BRAIN_SCHEMA_VERSION,
    exportedAt: Date.now(),
    store,
  };
}

export function parseBrainExport(input: unknown): StoreParseResult {
  if (typeof input === 'string') {
    try {
      return parseBrainExport(JSON.parse(input));
    } catch {
      return { store: createEmptyStore(), warnings: ['导入内容不是合法 JSON'], compatible: true };
    }
  }
  if (!input || typeof input !== 'object') {
    return { store: createEmptyStore(), warnings: ['导入内容不是对象'], compatible: true };
  }
  const raw = input as Record<string, unknown>;
  if (raw.kind !== BRAIN_EXPORT_KIND) {
    return { store: createEmptyStore(), warnings: ['不是紫微档案导出文件'], compatible: true };
  }
  return sanitizeBrainStore(raw.store);
}
