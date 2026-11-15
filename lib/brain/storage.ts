/**
 * brain 的 localStorage 读写与 CRUD。
 *
 * 读写函数接受可注入的 StorageLike，便于在 Node 脚本里用内存实现做回归测试。
 * 所有数据在写入前都经过 validate.ts 的白名单清洗。
 */

import {
  BRAIN_CORRUPT_BACKUP_KEY,
  BRAIN_LIMITS,
  BRAIN_LS_KEY,
  BRAIN_SCHEMA_VERSION,
  type BrainMemory,
  type BrainStore,
  type BrainSubject,
} from './types';
import {
  createBrainExport,
  createEmptyStore,
  normalizeForDedupe,
  parseBrainExport,
  sanitizeBrainStore,
} from './validate';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type BrainStorageErrorCode = 'quota' | 'unavailable';

export class BrainStorageError extends Error {
  constructor(
    readonly code: BrainStorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrainStorageError';
  }
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Safari 隐私模式等场景访问 localStorage 会直接抛 SecurityError
  }
  return null;
}

export interface LoadBrainResult {
  store: BrainStore;
  warnings: string[];
  compatible: boolean;
}

export function loadBrain(storage?: StorageLike): LoadBrainResult {
  const s = storage ?? defaultStorage();
  if (!s) return { store: createEmptyStore(), warnings: [], compatible: true };

  let raw: string | null = null;
  try {
    raw = s.getItem(BRAIN_LS_KEY);
  } catch {
    return { store: createEmptyStore(), warnings: ['当前环境无法读取本地档案'], compatible: true };
  }
  if (!raw) return { store: createEmptyStore(), warnings: [], compatible: true };

  try {
    return sanitizeBrainStore(JSON.parse(raw));
  } catch {
    try {
      s.setItem(BRAIN_CORRUPT_BACKUP_KEY, raw);
    } catch {
      // 备份失败也不能阻断读取流程
    }
    return {
      store: createEmptyStore(),
      warnings: ['档案数据损坏，已将原始内容备份到 ziwei-brain-v1-corrupt-backup'],
      compatible: true,
    };
  }
}

export function saveBrain(store: BrainStore, storage?: StorageLike): void {
  const s = storage ?? defaultStorage();
  if (!s) throw new BrainStorageError('unavailable', '当前环境不支持 localStorage，档案无法保存');

  const snapshot: BrainStore = {
    ...store,
    version: BRAIN_SCHEMA_VERSION,
    updatedAt: Date.now(),
  };

  try {
    s.setItem(BRAIN_LS_KEY, JSON.stringify(snapshot));
    return;
  } catch {
    // 配额不足：先丢弃体积最大的原文摘录与 tags，再试一次
    const trimmed: BrainStore = {
      ...snapshot,
      memories: snapshot.memories.map(memory => {
        const next: BrainMemory = { ...memory, tags: [] };
        const { question } = memory.source;
        next.source = question ? { kind: memory.source.kind, question } : { kind: memory.source.kind };
        return next;
      }),
    };
    try {
      s.setItem(BRAIN_LS_KEY, JSON.stringify(trimmed));
      return;
    } catch {
      throw new BrainStorageError('quota', '浏览器存储空间不足，请先导出档案再清理旧条目');
    }
  }
}

// ─── CRUD 纯函数 ─────────────────────────────────────────────

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // 某些非安全上下文没有 randomUUID
  }
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function newMemory(
  input: Omit<BrainMemory, 'id' | 'createdAt' | 'updatedAt'>,
): BrainMemory {
  const now = Date.now();
  return { ...input, id: newId(), createdAt: now, updatedAt: now };
}

/** 每个指纹/全库的条数上限：优先淘汰最旧的 unverified，再淘汰最旧的 */
function enforceLimits(memories: BrainMemory[]): BrainMemory[] {
  const byFingerprint = new Map<string, BrainMemory[]>();
  for (const memory of memories) {
    const list = byFingerprint.get(memory.fingerprint) ?? [];
    list.push(memory);
    byFingerprint.set(memory.fingerprint, list);
  }

  const kept: BrainMemory[] = [];
  for (const list of byFingerprint.values()) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    if (list.length <= BRAIN_LIMITS.maxMemoriesPerSubject) {
      kept.push(...list);
      continue;
    }
    const sortedForEviction = [...list].sort((a, b) => {
      if (a.status !== b.status) {
        if (a.status === 'unverified') return -1;
        if (b.status === 'unverified') return 1;
      }
      return a.updatedAt - b.updatedAt;
    });
    const evict = new Set(sortedForEviction.slice(0, list.length - BRAIN_LIMITS.maxMemoriesPerSubject));
    kept.push(...list.filter(memory => !evict.has(memory)));
  }

  kept.sort((a, b) => b.updatedAt - a.updatedAt);
  if (kept.length <= BRAIN_LIMITS.maxMemoriesTotal) return kept;

  const sortedForEviction = [...kept].sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === 'unverified') return -1;
      if (b.status === 'unverified') return 1;
    }
    return a.updatedAt - b.updatedAt;
  });
  const evict = new Set(sortedForEviction.slice(0, kept.length - BRAIN_LIMITS.maxMemoriesTotal));
  return kept.filter(memory => !evict.has(memory));
}

export function insertMemories(store: BrainStore, memories: BrainMemory[]): BrainStore {
  if (!memories.length) return store;
  const incomingIds = new Set(memories.map(memory => memory.id));
  const merged = [...memories, ...store.memories.filter(memory => !incomingIds.has(memory.id))];
  return { ...store, memories: enforceLimits(merged), updatedAt: Date.now() };
}

export function updateMemory(
  store: BrainStore,
  id: string,
  patch: Partial<Pick<BrainMemory, 'topic' | 'conclusion' | 'evidence' | 'confidence' | 'status' | 'tags'>>,
): BrainStore {
  const memories = store.memories.map(memory =>
    memory.id === id ? { ...memory, ...patch, updatedAt: Date.now() } : memory,
  );
  return { ...store, memories, updatedAt: Date.now() };
}

export function removeMemory(store: BrainStore, id: string): BrainStore {
  return { ...store, memories: store.memories.filter(memory => memory.id !== id), updatedAt: Date.now() };
}

export function upsertSubject(store: BrainStore, subject: BrainSubject): BrainStore {
  return {
    ...store,
    subjects: { ...store.subjects, [subject.fingerprint]: { ...subject, updatedAt: Date.now() } },
    updatedAt: Date.now(),
  };
}

export function setInjectEnabled(store: BrainStore, enabled: boolean): BrainStore {
  return { ...store, settings: { ...store.settings, injectEnabled: enabled }, updatedAt: Date.now() };
}

export function exportBrain(store: BrainStore): string {
  return JSON.stringify(createBrainExport(store), null, 2);
}

/**
 * 导入档案并与现有数据合并：
 * - 同 id 的记忆以导入数据为准；
 * - 同指纹的 subject 以导入数据为准；
 * - settings 保持本机当前值。
 */
export function importBrain(store: BrainStore, input: unknown): { store: BrainStore; warnings: string[]; error?: string } {
  const parsed = parseBrainExport(input);
  if (!parsed.compatible) return { store, warnings: parsed.warnings, error: parsed.warnings[0] };
  if (!parsed.store.memories.length && !Object.keys(parsed.store.subjects).length) {
    return { store, warnings: parsed.warnings, error: '导入文件中没有档案数据' };
  }

  const importedIds = new Set(parsed.store.memories.map(memory => memory.id));
  const memories = [
    ...parsed.store.memories,
    ...store.memories.filter(memory => !importedIds.has(memory.id)),
  ];

  return {
    store: {
      ...store,
      subjects: { ...store.subjects, ...parsed.store.subjects },
      memories: enforceLimits(memories),
      updatedAt: Date.now(),
    },
    warnings: parsed.warnings,
  };
}

/** 当前指纹下是否已有相同结论（用于保存前提示重复） */
export function hasDuplicateConclusion(store: BrainStore, fingerprint: string, conclusion: string): boolean {
  const key = normalizeForDedupe(conclusion);
  return store.memories.some(
    memory => memory.fingerprint === fingerprint && normalizeForDedupe(memory.conclusion) === key,
  );
}
