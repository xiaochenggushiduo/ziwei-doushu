/**
 * 用户长期档案（brain）的数据模型。
 *
 * 设计原则：档案只是解读时的背景上下文，不是紫微斗数的规则或盘面证据；
 * 所有条目都按命盘指纹隔离，避免给不同人排盘时串档。
 */

export const BRAIN_SCHEMA_VERSION = 1;
export const BRAIN_LS_KEY = 'ziwei-brain-v1';
export const BRAIN_CORRUPT_BACKUP_KEY = 'ziwei-brain-v1-corrupt-backup';
export const BRAIN_EXPORT_KIND = 'ziwei-brain-export';
export const BRAIN_CHANGED_EVENT = 'ziwei-brain-changed';

export type BrainTopic =
  | 'personality'
  | 'career'
  | 'wealth'
  | 'love'
  | 'health'
  | 'family'
  | 'study'
  | 'travel'
  | 'fortune'
  | 'relationship'
  | 'other';

export type BrainConfidence = 'high' | 'medium' | 'low';
export type BrainStatus = 'unverified' | 'confirmed' | 'refuted';
export type SiHuaChar = '禄' | '权' | '科' | '忌';

/** 一条可核对的依据：盘面宫位/星曜/格局，或解读回答的原文片段 */
export type MemoryEvidence =
  | { type: 'palace'; name: string }
  | { type: 'star'; name: string; palace?: string; siHua?: SiHuaChar }
  | { type: 'pattern'; name: string }
  | { type: 'answer'; quote: string };

export interface BrainMemory {
  id: string;
  /** 所属命盘指纹，见 fingerprint.ts */
  fingerprint: string;
  topic: BrainTopic;
  /** 结论 ≤ BRAIN_LIMITS.maxConclusionChars 字 */
  conclusion: string;
  /** 1–4 条盘面/原文依据 */
  evidence: MemoryEvidence[];
  confidence: BrainConfidence;
  status: BrainStatus;
  tags: string[];
  source: {
    kind: 'interpret' | 'manual';
    /** 仅本机留档，不随解读请求发送 */
    question?: string;
    /** 仅本机留档，不随解读请求发送 */
    answerExcerpt?: string;
  };
  createdAt: number;
  updatedAt: number;
}

/** 用于一键回填 BirthForm 的表单快照（结构与 BirthFormState 一致） */
export interface BrainSubjectForm {
  name: string;
  year: string;
  month: string;
  day: string;
  clockHour: string;
  clockMinute: string;
  unknownTime: boolean;
  province: string;
  city: string;
  longitude: number;
  gender: 'male' | 'female';
}

export interface BrainSubject {
  fingerprint: string;
  /** 仅用于 UI 识别，不参与指纹 */
  label: string;
  form?: BrainSubjectForm;
  createdAt: number;
  updatedAt: number;
}

export interface BrainStore {
  version: typeof BRAIN_SCHEMA_VERSION;
  updatedAt: number;
  /** fingerprint -> subject */
  subjects: Record<string, BrainSubject>;
  memories: BrainMemory[];
  settings: {
    /** 关闭后解读请求不再携带档案 */
    injectEnabled: boolean;
  };
}

/** 发往服务端的最小投影：剥离 source/tags/createdAt，减少隐私面与体积 */
export interface BrainPayloadMemory {
  id: string;
  topic: BrainTopic;
  conclusion: string;
  evidence: MemoryEvidence[];
  confidence: BrainConfidence;
  status: BrainStatus;
  updatedAt: number;
}

export interface BrainPayload {
  fingerprint: string;
  memories: BrainPayloadMemory[];
}

/** 提炼接口返回的草稿；id/时间戳由前端补 */
export interface BrainMemoryDraft {
  topic: BrainTopic;
  conclusion: string;
  evidence: MemoryEvidence[];
  confidence: BrainConfidence;
  source: {
    kind: 'interpret';
    question?: string;
    answerExcerpt: string;
  };
}

export const BRAIN_LIMITS = {
  maxMemoriesTotal: 300,
  maxMemoriesPerSubject: 100,
  maxConclusionChars: 120,
  maxEvidenceItems: 4,
  maxQuoteChars: 80,
  maxTags: 4,
  maxTagChars: 12,
  maxQuestionChars: 200,
  maxAnswerExcerptChars: 300,
  maxPayloadMemories: 40,
  maxPayloadChars: 12000,
  maxInjectItems: 10,
  maxInjectChars: 1500,
  maxRefutedItems: 3,
  maxRefutedChars: 60,
  maxExtractAnswerChars: 8000,
  maxExtractItems: 5,
} as const;

export const BRAIN_TOPIC_LABELS: Record<BrainTopic, string> = {
  personality: '性格',
  career: '事业',
  wealth: '财运',
  love: '感情',
  health: '健康',
  family: '六亲',
  study: '学业',
  travel: '迁移',
  fortune: '大限流年',
  relationship: '关系',
  other: '其他',
};

export const BRAIN_TOPICS = Object.keys(BRAIN_TOPIC_LABELS) as BrainTopic[];

export const BRAIN_CONFIDENCE_LABELS: Record<BrainConfidence, string> = {
  high: '高置信',
  medium: '中置信',
  low: '低置信',
};

export const BRAIN_STATUS_LABELS: Record<BrainStatus, string> = {
  unverified: '未验证',
  confirmed: '已确认',
  refuted: '已推翻',
};
