'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { ZiweiChart } from '@/lib/ziwei/types';
import {
  BRAIN_CHANGED_EVENT,
  BRAIN_LS_KEY,
  type BrainMemory,
  type BrainStore,
  type BrainSubject,
  type BrainSubjectForm,
} from './types';
import { createEmptyStore, sanitizeBrainStore } from './validate';
import {
  exportBrain,
  importBrain,
  insertMemories,
  newMemory,
  removeMemory,
  saveBrain,
  setInjectEnabled,
  updateMemory,
  upsertSubject,
} from './storage';
import { chartFingerprint, formatSubjectLabel } from './fingerprint';

const EMPTY_STORE = createEmptyStore();

let cachedRaw: string | null | undefined;
let cachedStore: BrainStore = EMPTY_STORE;

function readSnapshot(): BrainStore {
  if (typeof window === 'undefined') return EMPTY_STORE;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(BRAIN_LS_KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedStore;

  cachedRaw = raw;
  if (!raw) {
    cachedStore = EMPTY_STORE;
    return cachedStore;
  }
  try {
    cachedStore = sanitizeBrainStore(JSON.parse(raw)).store;
  } catch {
    cachedStore = EMPTY_STORE;
  }
  return cachedStore;
}

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === BRAIN_LS_KEY) callback();
  };
  const onLocal = () => callback();
  window.addEventListener('storage', onStorage);
  window.addEventListener(BRAIN_CHANGED_EVENT, onLocal);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(BRAIN_CHANGED_EVENT, onLocal);
  };
}

function emitChange(): void {
  try {
    window.dispatchEvent(new Event(BRAIN_CHANGED_EVENT));
  } catch {
    // SSR / 受限环境忽略
  }
}

function mutate(fn: (store: BrainStore) => BrainStore): BrainStore {
  const next = fn(readSnapshot());
  saveBrain(next);
  emitChange();
  return next;
}

export interface UseBrainResult {
  store: BrainStore;
  subjects: BrainSubject[];
  memoriesFor: (fingerprint: string) => BrainMemory[];
  addMemories: (
    inputs: Array<Omit<BrainMemory, 'id' | 'createdAt' | 'updatedAt'>>,
  ) => BrainMemory[];
  updateMemory: (
    id: string,
    patch: Partial<Pick<BrainMemory, 'topic' | 'conclusion' | 'evidence' | 'confidence' | 'status' | 'tags'>>,
  ) => void;
  removeMemory: (id: string) => void;
  upsertSubject: (subject: BrainSubject) => void;
  rememberSubject: (chart: ZiweiChart, form?: BrainSubjectForm | null) => void;
  setInjectEnabled: (enabled: boolean) => void;
  exportJson: () => string;
  importJson: (input: unknown) => { warnings: string[]; error?: string };
}

export function useBrain(): UseBrainResult {
  const store = useSyncExternalStore(subscribe, readSnapshot, () => EMPTY_STORE);

  const memoriesFor = useCallback(
    (fingerprint: string) => store.memories.filter(memory => memory.fingerprint === fingerprint),
    [store],
  );

  const addMemories = useCallback(
    (inputs: Array<Omit<BrainMemory, 'id' | 'createdAt' | 'updatedAt'>>) => {
      const memories = inputs.map(newMemory);
      if (memories.length) mutate(current => insertMemories(current, memories));
      return memories;
    },
    [],
  );

  const updateMemoryById = useCallback(
    (
      id: string,
      patch: Partial<Pick<BrainMemory, 'topic' | 'conclusion' | 'evidence' | 'confidence' | 'status' | 'tags'>>,
    ) => {
      mutate(current => updateMemory(current, id, patch));
    },
    [],
  );

  const removeMemoryById = useCallback((id: string) => {
    mutate(current => removeMemory(current, id));
  }, []);

  const upsertSubjectEntry = useCallback((subject: BrainSubject) => {
    mutate(current => upsertSubject(current, subject));
  }, []);

  const rememberSubject = useCallback((chart: ZiweiChart, form?: BrainSubjectForm | null) => {
    const fingerprint = chartFingerprint(chart);
    const label = formatSubjectLabel(chart);
    const existing = readSnapshot().subjects[fingerprint];
    mutate(current =>
      upsertSubject(current, {
        fingerprint,
        label,
        form: form ?? existing?.form,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }, []);

  const setInject = useCallback((enabled: boolean) => {
    mutate(current => setInjectEnabled(current, enabled));
  }, []);

  const exportJson = useCallback(() => exportBrain(readSnapshot()), []);

  const importJson = useCallback((input: unknown) => {
    const result = importBrain(readSnapshot(), input);
    if (!result.error) {
      saveBrain(result.store);
      emitChange();
    }
    return { warnings: result.warnings, error: result.error };
  }, []);

  return {
    store,
    subjects: Object.values(store.subjects),
    memoriesFor,
    addMemories,
    updateMemory: updateMemoryById,
    removeMemory: removeMemoryById,
    upsertSubject: upsertSubjectEntry,
    rememberSubject,
    setInjectEnabled: setInject,
    exportJson,
    importJson,
  };
}
