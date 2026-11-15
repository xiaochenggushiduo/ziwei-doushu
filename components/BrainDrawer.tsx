'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ZiweiChart } from '@/lib/ziwei/types';
import {
  BRAIN_CONFIDENCE_LABELS,
  BRAIN_STATUS_LABELS,
  BRAIN_TOPIC_LABELS,
  type BrainMemory,
  type BrainMemoryDraft,
  type BrainStatus,
} from '@/lib/brain/types';
import { formatEvidenceShort } from '@/lib/brain/format';
import { chartFingerprint } from '@/lib/brain/fingerprint';
import { useBrain } from '@/lib/brain/use-brain';
import { normalizeForDedupe } from '@/lib/brain/validate';
import BrainCaptureSheet from './BrainCaptureSheet';

interface BrainDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 有命盘时可新建/编辑条目；未起盘时只能查看与导出 */
  chart?: ZiweiChart | null;
  defaultFingerprint?: string;
}

const STATUS_FILTERS: Array<{ key: 'all' | BrainStatus; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'unverified', label: '未验证' },
  { key: 'confirmed', label: '已确认' },
  { key: 'refuted', label: '已推翻' },
];

export default function BrainDrawer({ open, onClose, chart, defaultFingerprint }: BrainDrawerProps) {
  const brain = useBrain();
  const [selectedFp, setSelectedFp] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | BrainStatus>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<BrainMemory | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureDrafts, setCaptureDrafts] = useState<BrainMemoryDraft[]>([]);
  const [message, setMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedFp(defaultFingerprint ?? 'all');
    setStatusFilter('all');
    setSearch('');
    setMessage('');
    setEditing(null);
    setCaptureOpen(false);
  }, [open, defaultFingerprint]);

  const currentFp = selectedFp === 'all' ? defaultFingerprint : selectedFp;

  const memories = useMemo(() => {
    const keyword = search.trim();
    return brain.store.memories
      .filter(memory => selectedFp === 'all' || memory.fingerprint === selectedFp)
      .filter(memory => statusFilter === 'all' || memory.status === statusFilter)
      .filter(memory => {
        if (!keyword) return true;
        return (
          memory.conclusion.includes(keyword) ||
          memory.evidence.some(evidence =>
            'name' in evidence ? evidence.name.includes(keyword) : evidence.quote.includes(keyword),
          ) ||
          memory.tags.some(tag => tag.includes(keyword))
        );
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [brain.store.memories, selectedFp, statusFilter, search]);

  const openNew = () => {
    if (!chart) {
      setMessage('请先排盘，再手动新建档案');
      return;
    }
    setEditing(null);
    setCaptureDrafts([]);
    setCaptureOpen(true);
  };

  const openEdit = (memory: BrainMemory) => {
    setEditing(memory);
    setCaptureDrafts([
      {
        topic: memory.topic,
        conclusion: memory.conclusion,
        evidence: memory.evidence,
        confidence: memory.confidence,
        source: {
          kind: 'interpret',
          question: memory.source.question,
          answerExcerpt: memory.source.answerExcerpt ?? '',
        },
      },
    ]);
    setCaptureOpen(true);
  };

  const handleCaptureSave = (drafts: BrainMemoryDraft[]) => {
    try {
      if (editing) {
        const draft = drafts[0];
        if (draft) {
          brain.updateMemory(editing.id, {
            topic: draft.topic,
            conclusion: draft.conclusion,
            evidence: draft.evidence,
            confidence: draft.confidence,
          });
          setMessage('已保存修改');
        }
      } else if (chart) {
        const fingerprint = chartFingerprint(chart);
        const inserted = brain.addMemories(
          drafts.map(draft => ({
            fingerprint,
            topic: draft.topic,
            conclusion: draft.conclusion,
            evidence: draft.evidence,
            confidence: draft.confidence,
            status: 'unverified' as const,
            tags: [],
            source: draft.source,
          })),
        );
        setMessage(`已存入 ${inserted.length} 条`);
      }
      setCaptureOpen(false);
      setEditing(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败，请先导出并清理旧条目');
    }
  };

  const handleExport = () => {
    try {
      const blob = new Blob([brain.exportJson()], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `紫微档案_${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage('已导出档案文件');
    } catch {
      setMessage('导出失败，请检查浏览器存储权限');
    }
  };

  const handleImport = async (file: File) => {
    try {
      const text = await file.text();
      const result = brain.importJson(text);
      setMessage(result.error ?? result.warnings[0] ?? `已导入 ${result.warnings.length ? '（含提示）' : ''}`);
    } catch {
      setMessage('导入失败，文件无法读取');
    }
  };

  const handleClear = () => {
    if (!currentFp) return;
    const target = brain.memoriesFor(currentFp);
    if (!target.length) return;
    if (!window.confirm(`确定删除该命盘下的 ${target.length} 条档案？此操作不可撤销。`)) return;
    for (const memory of target) brain.removeMemory(memory.id);
    setMessage('已清空当前命盘的档案');
  };

  const handleDelete = (memory: BrainMemory) => {
    if (!window.confirm('删除这条档案？')) return;
    brain.removeMemory(memory.id);
  };

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[105]"
            style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)' }}
            onClick={onClose}
          >
            <motion.aside
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
              onClick={event => event.stopPropagation()}
              className="absolute right-0 top-0 h-full w-full max-w-[540px] flex flex-col"
              style={{ background: 'var(--t-card)', borderLeft: '1px solid var(--t-border)' }}
            >
              {/* 顶部 */}
              <div className="px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--t-border)' }}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium tracking-widest" style={{ color: 'var(--t-gold)' }}>
                      ✦ 我的档案
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color: 'var(--t-faint)' }}>
                      仅供解读参考 · 不是盘面证据 · 盘面永远优先
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

                <label className="flex items-center gap-2 mt-3 text-[10px]" style={{ color: 'var(--t-faint)' }}>
                  <input
                    type="checkbox"
                    checked={brain.store.settings.injectEnabled}
                    onChange={event => brain.setInjectEnabled(event.target.checked)}
                  />
                  解读时注入档案
                </label>
              </div>

              {/* 对象 / 筛选 */}
              <div className="px-4 py-2.5 flex-shrink-0 space-y-2" style={{ borderBottom: '1px solid var(--t-border)' }}>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => setSelectedFp('all')}
                    className="px-2 py-1 rounded-md text-[10px]"
                    style={{
                      border: '1px solid var(--t-border)',
                      background: selectedFp === 'all' ? 'rgba(212,168,67,0.14)' : 'transparent',
                      color: selectedFp === 'all' ? 'var(--t-gold)' : 'var(--t-faint)',
                    }}
                  >
                    全部对象
                  </button>
                  {brain.subjects.map(subject => (
                    <button
                      key={subject.fingerprint}
                      onClick={() => setSelectedFp(subject.fingerprint)}
                      className="px-2 py-1 rounded-md text-[10px] max-w-[220px] truncate"
                      title={subject.label}
                      style={{
                        border: '1px solid var(--t-border)',
                        background: selectedFp === subject.fingerprint ? 'rgba(212,168,67,0.14)' : 'transparent',
                        color: selectedFp === subject.fingerprint ? 'var(--t-gold)' : 'var(--t-faint)',
                      }}
                    >
                      {subject.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1.5">
                  {STATUS_FILTERS.map(filter => (
                    <button
                      key={filter.key}
                      onClick={() => setStatusFilter(filter.key)}
                      className="px-2 py-1 rounded-md text-[10px]"
                      style={{
                        border: '1px solid var(--t-border)',
                        background: statusFilter === filter.key ? 'rgba(212,168,67,0.14)' : 'transparent',
                        color: statusFilter === filter.key ? 'var(--t-gold)' : 'var(--t-faint)',
                      }}
                    >
                      {filter.label}
                    </button>
                  ))}
                  <input
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                    placeholder="搜索结论/依据"
                    className="ml-auto w-[140px] rounded-md px-2 py-1 text-[10px] focus:outline-none"
                    style={{
                      background: 'var(--t-bg, #0b1220)',
                      border: '1px solid var(--t-border)',
                      color: 'var(--t-text)',
                    }}
                  />
                </div>
              </div>

              {/* 列表 */}
              <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
                {memories.length === 0 && (
                  <div className="text-center text-[11px] py-10" style={{ color: 'var(--t-faint)' }}>
                    还没有档案。<br />
                    在 AI 解读下点「记住这条」即可沉淀结论。
                  </div>
                )}

                {memories.map(memory => (
                  <div
                    key={memory.id}
                    className="rounded-xl p-3 space-y-2"
                    style={{ border: '1px solid var(--t-border)', background: 'rgba(255,255,255,0.02)' }}
                  >
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className="px-1.5 py-0.5 rounded text-[9px]"
                        style={{ background: 'rgba(212,168,67,0.1)', color: 'var(--t-gold)' }}
                      >
                        {BRAIN_TOPIC_LABELS[memory.topic]}
                      </span>
                      <span className="text-[9px]" style={{ color: 'var(--t-faint)' }}>
                        {BRAIN_CONFIDENCE_LABELS[memory.confidence]}
                      </span>
                      <span
                        className="px-1.5 py-0.5 rounded text-[9px] ml-auto"
                        style={{
                          background:
                            memory.status === 'confirmed'
                              ? 'rgba(16,185,129,0.1)'
                              : memory.status === 'refuted'
                                ? 'rgba(239,68,68,0.1)'
                                : 'rgba(148,163,184,0.1)',
                          color:
                            memory.status === 'confirmed'
                              ? '#10b981'
                              : memory.status === 'refuted'
                                ? '#ef4444'
                                : 'var(--t-faint)',
                        }}
                      >
                        {BRAIN_STATUS_LABELS[memory.status]}
                      </span>
                    </div>

                    <div className="text-[12px] leading-relaxed" style={{ color: 'var(--t-text)' }}>
                      {memory.conclusion}
                    </div>

                    <div className="flex flex-wrap gap-1">
                      {memory.evidence.map((evidence, index) => (
                        <span
                          key={index}
                          className="px-1.5 py-0.5 rounded text-[9px]"
                          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--t-faint)' }}
                        >
                          {formatEvidenceShort(evidence)}
                        </span>
                      ))}
                    </div>

                    <div className="flex items-center gap-1 text-[9px]" style={{ color: 'var(--t-faint)' }}>
                      <span>{new Date(memory.updatedAt).toLocaleDateString('zh-CN')}</span>
                      <span className="ml-auto flex gap-1">
                        <button onClick={() => brain.updateMemory(memory.id, { status: 'unverified' })}>未验证</button>
                        <button onClick={() => brain.updateMemory(memory.id, { status: 'confirmed' })}>确认</button>
                        <button onClick={() => brain.updateMemory(memory.id, { status: 'refuted' })}>推翻</button>
                        <button onClick={() => openEdit(memory)}>编辑</button>
                        <button onClick={() => handleDelete(memory)} style={{ color: '#ef4444' }}>
                          删除
                        </button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* 底部操作 */}
              <div className="px-4 py-3 flex-shrink-0 space-y-2" style={{ borderTop: '1px solid var(--t-border)' }}>
                {message && <div className="text-[10px]" style={{ color: 'var(--t-gold)' }}>{message}</div>}
                <div className="flex items-center gap-2">
                  <button
                    onClick={openNew}
                    disabled={!chart}
                    className="px-3 py-1.5 rounded-lg text-[10px] disabled:opacity-30"
                    style={{ border: '1px solid var(--t-border)', color: 'var(--t-gold)' }}
                  >
                    ＋ 手动新建
                  </button>
                  <button
                    onClick={handleExport}
                    className="px-3 py-1.5 rounded-lg text-[10px]"
                    style={{ border: '1px solid var(--t-border)', color: 'var(--t-faint)' }}
                  >
                    导出
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3 py-1.5 rounded-lg text-[10px]"
                    style={{ border: '1px solid var(--t-border)', color: 'var(--t-faint)' }}
                  >
                    导入
                  </button>
                  <button
                    onClick={handleClear}
                    className="ml-auto px-3 py-1.5 rounded-lg text-[10px]"
                    style={{ border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444' }}
                  >
                    清空当前
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={event => {
                    const file = event.target.files?.[0];
                    if (file) void handleImport(file);
                    event.target.value = '';
                  }}
                />
                <div className="text-[9px] leading-relaxed" style={{ color: 'var(--t-faint)' }}>
                  档案保存在本机浏览器；发起 AI 解读时，相关条目会随请求发送给 AI 服务商。
                </div>
              </div>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      {chart && (
        <BrainCaptureSheet
          open={captureOpen}
          chart={chart}
          title={editing ? '编辑档案' : '手动新建档案'}
          drafts={captureDrafts}
          existingConclusions={
            currentFp
              ? new Set(brain.memoriesFor(currentFp).map(memory => normalizeForDedupe(memory.conclusion)))
              : undefined
          }
          onClose={() => {
            setCaptureOpen(false);
            setEditing(null);
          }}
          onSave={handleCaptureSave}
        />
      )}
    </>
  );
}
