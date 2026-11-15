'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ZiweiChart } from '@/lib/ziwei/types';
import {
  BRAIN_CONFIDENCE_LABELS,
  BRAIN_LIMITS,
  BRAIN_TOPIC_LABELS,
  BRAIN_TOPICS,
  type BrainConfidence,
  type BrainMemoryDraft,
  type BrainTopic,
  type MemoryEvidence,
} from '@/lib/brain/types';
import { formatEvidenceShort } from '@/lib/brain/format';
import { normalizeForDedupe } from '@/lib/brain/validate';

interface BrainCaptureSheetProps {
  open: boolean;
  chart: ZiweiChart;
  title?: string;
  drafts: BrainMemoryDraft[];
  warnings?: string[];
  /** 当前指纹下已存在的结论（归一化后），用于提示重复 */
  existingConclusions?: Set<string>;
  onClose: () => void;
  onSave: (drafts: BrainMemoryDraft[]) => void;
}

const CONFIDENCES: BrainConfidence[] = ['high', 'medium', 'low'];

function emptyDraft(): BrainMemoryDraft {
  return {
    topic: 'other',
    conclusion: '',
    evidence: [],
    confidence: 'low',
    source: { kind: 'interpret', answerExcerpt: '' },
  };
}

export default function BrainCaptureSheet({
  open,
  chart,
  title = '存入我的档案',
  drafts,
  warnings = [],
  existingConclusions,
  onClose,
  onSave,
}: BrainCaptureSheetProps) {
  const [items, setItems] = useState<BrainMemoryDraft[]>([]);
  const [picker, setPicker] = useState('');

  useEffect(() => {
    if (open) {
      setItems(drafts.length ? drafts.map(draft => ({ ...draft, evidence: [...draft.evidence] })) : [emptyDraft()]);
      setPicker('');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const palaceOptions = useMemo(() => chart.palaces.map(palace => palace.name), [chart]);

  const starOptions = useMemo(() => {
    const names = new Set<string>();
    for (const palace of chart.palaces) {
      for (const star of palace.stars) names.add(star.name);
      for (const borrowed of palace.borrowedStars ?? []) names.add(borrowed);
    }
    return [...names];
  }, [chart]);

  const patch = (index: number, changes: Partial<BrainMemoryDraft>) => {
    setItems(prev => prev.map((item, i) => (i === index ? { ...item, ...changes } : item)));
  };

  const removeEvidence = (index: number, evidenceIndex: number) => {
    setItems(prev =>
      prev.map((item, i) =>
        i === index ? { ...item, evidence: item.evidence.filter((_, j) => j !== evidenceIndex) } : item,
      ),
    );
  };

  const addEvidence = (index: number, value: string) => {
    if (!value) return;
    const [type, name] = value.split('::');
    let evidence: MemoryEvidence | null = null;
    if (type === 'palace') evidence = { type: 'palace', name };
    else if (type === 'star') evidence = { type: 'star', name };
    if (!evidence) return;

    setItems(prev =>
      prev.map((item, i) => {
        if (i !== index) return item;
        if (item.evidence.length >= BRAIN_LIMITS.maxEvidenceItems) return item;
        if (item.evidence.some(existing => formatEvidenceShort(existing) === formatEvidenceShort(evidence!))) {
          return item;
        }
        return { ...item, evidence: [...item.evidence, evidence!] };
      }),
    );
    setPicker('');
  };

  const validItems = items.filter(item => item.conclusion.trim() && item.evidence.length > 0);

  const handleSave = () => {
    if (!validItems.length) return;
    onSave(
      validItems.map(item => ({
        ...item,
        conclusion: item.conclusion.trim().slice(0, BRAIN_LIMITS.maxConclusionChars),
      })),
    );
  };

  const isDuplicate = (conclusion: string) =>
    !!existingConclusions && existingConclusions.has(normalizeForDedupe(conclusion));

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[110] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 16 }}
            transition={{ duration: 0.2 }}
            onClick={event => event.stopPropagation()}
            className="rounded-2xl overflow-hidden flex flex-col"
            style={{
              background: 'var(--t-card)',
              border: '1px solid var(--t-border)',
              width: '100%',
              maxWidth: 620,
              maxHeight: '90vh',
              boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-3 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--t-border)' }}
            >
              <div>
                <div className="text-xs font-medium tracking-widest" style={{ color: 'var(--t-gold)' }}>
                  ✦ {title}
                </div>
                <div className="text-[10px] mt-0.5" style={{ color: 'var(--t-faint)' }}>
                  只保存可核对的结论；依据必须来自盘面或解读原文
                </div>
              </div>
              <button
                onClick={onClose}
                className="w-7 h-7 rounded-full text-sm"
                style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--t-faint)' }}
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
              {warnings.length > 0 && (
                <div
                  className="text-[10px] leading-relaxed rounded-lg p-2.5"
                  style={{ background: 'rgba(245,158,11,0.08)', color: '#d97706' }}
                >
                  {warnings.map((warning, index) => (
                    <div key={index}>· {warning}</div>
                  ))}
                </div>
              )}

              {items.map((item, index) => {
                const duplicate = isDuplicate(item.conclusion);
                return (
                  <div
                    key={index}
                    className="rounded-xl p-3 space-y-2.5"
                    style={{ border: '1px solid var(--t-border)', background: 'rgba(255,255,255,0.02)' }}
                  >
                    <div className="flex items-center gap-2">
                      <select
                        value={item.topic}
                        onChange={event => patch(index, { topic: event.target.value as BrainTopic })}
                        className="rounded-md px-2 py-1 text-[11px]"
                        style={{ background: 'var(--t-bg, #0b1220)', border: '1px solid var(--t-border)', color: 'var(--t-text)' }}
                      >
                        {BRAIN_TOPICS.map(topic => (
                          <option key={topic} value={topic}>
                            {BRAIN_TOPIC_LABELS[topic]}
                          </option>
                        ))}
                      </select>

                      <div className="flex gap-1 ml-auto">
                        {CONFIDENCES.map(level => (
                          <button
                            key={level}
                            onClick={() => patch(index, { confidence: level })}
                            className="px-2 py-1 rounded-md text-[10px]"
                            style={{
                              border: '1px solid var(--t-border)',
                              background: item.confidence === level ? 'rgba(212,168,67,0.16)' : 'transparent',
                              color: item.confidence === level ? 'var(--t-gold)' : 'var(--t-faint)',
                            }}
                          >
                            {BRAIN_CONFIDENCE_LABELS[level]}
                          </button>
                        ))}
                      </div>

                      <button
                        onClick={() => setItems(prev => prev.filter((_, i) => i !== index))}
                        className="text-[10px] px-1.5 py-1"
                        style={{ color: 'var(--t-faint)' }}
                        title="删除这条草稿"
                      >
                        删除
                      </button>
                    </div>

                    <textarea
                      value={item.conclusion}
                      onChange={event => patch(index, { conclusion: event.target.value })}
                      maxLength={BRAIN_LIMITS.maxConclusionChars}
                      rows={2}
                      placeholder="一句话结论，例如：命宫天机化禄，适合智谋型工作。"
                      className="w-full rounded-lg px-2.5 py-2 text-[12px] leading-relaxed resize-none focus:outline-none"
                      style={{
                        background: 'var(--t-bg, #0b1220)',
                        border: '1px solid var(--t-border)',
                        color: 'var(--t-text)',
                      }}
                    />

                    <div className="flex items-center justify-between">
                      <div className="flex flex-wrap gap-1.5">
                        {item.evidence.map((evidence, evidenceIndex) => (
                          <button
                            key={evidenceIndex}
                            onClick={() => removeEvidence(index, evidenceIndex)}
                            className="px-2 py-1 rounded-md text-[10px]"
                            style={{
                              background: 'rgba(212,168,67,0.08)',
                              border: '1px solid rgba(212,168,67,0.2)',
                              color: 'var(--t-gold)',
                            }}
                            title="点击移除"
                          >
                            {formatEvidenceShort(evidence)} ×
                          </button>
                        ))}
                        {item.evidence.length === 0 && (
                          <span className="text-[10px]" style={{ color: '#ef4444' }}>
                            至少需要一条盘面依据
                          </span>
                        )}
                      </div>
                      <span className="text-[9px]" style={{ color: 'var(--t-faint)' }}>
                        {item.conclusion.length}/{BRAIN_LIMITS.maxConclusionChars}
                      </span>
                    </div>

                    <select
                      value={picker}
                      onChange={event => addEvidence(index, event.target.value)}
                      className="rounded-md px-2 py-1 text-[10px] w-full"
                      style={{ background: 'var(--t-bg, #0b1220)', border: '1px solid var(--t-border)', color: 'var(--t-faint)' }}
                    >
                      <option value="">＋ 添加盘面依据（宫位 / 星曜）</option>
                      <optgroup label="宫位">
                        {palaceOptions.map(name => (
                          <option key={`p-${name}`} value={`palace::${name}`}>
                            {name}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="星曜">
                        {starOptions.map(name => (
                          <option key={`s-${name}`} value={`star::${name}`}>
                            {name}
                          </option>
                        ))}
                      </optgroup>
                    </select>

                    {duplicate && (
                      <div className="text-[10px]" style={{ color: '#d97706' }}>
                        该结论已存在于档案中，保存会新增一条重复记录。
                      </div>
                    )}
                  </div>
                );
              })}

              <button
                onClick={() => setItems(prev => [...prev, emptyDraft()])}
                className="w-full py-2 rounded-lg text-[10px]"
                style={{ border: '1px dashed var(--t-border)', color: 'var(--t-faint)' }}
              >
                ＋ 再加一条
              </button>
            </div>

            <div
              className="flex items-center justify-end gap-2 px-4 py-3 flex-shrink-0"
              style={{ borderTop: '1px solid var(--t-border)' }}
            >
              <button
                onClick={onClose}
                className="px-3 py-2 rounded-lg text-[11px]"
                style={{ border: '1px solid var(--t-border)', color: 'var(--t-faint)' }}
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={!validItems.length}
                className="px-4 py-2 rounded-lg text-[11px] font-medium disabled:opacity-30"
                style={{
                  background: 'rgba(212,168,67,0.16)',
                  border: '1px solid rgba(212,168,67,0.3)',
                  color: 'var(--t-gold)',
                }}
              >
                保存 {validItems.length} 条
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
