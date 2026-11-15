'use client';
import { useState } from 'react';
import BirthForm, { type BirthFormState } from '@/components/BirthForm';
import ChartBoard from '@/components/ChartBoard';
import InsightPanel from '@/components/InsightPanel';
import TimeNav, { type TimeView } from '@/components/TimeNav';
import BrainDrawer from '@/components/BrainDrawer';
import { generateChart } from '@/lib/ziwei/algorithm';
import { chartFingerprint } from '@/lib/brain/fingerprint';
import { useBrain } from '@/lib/brain/use-brain';
import type { BirthInfo, ZiweiChart, Palace } from '@/lib/ziwei/types';

const buttonStyle = {
  padding: '6px 14px',
  cursor: 'pointer',
  border: '1px solid #ccc',
  borderRadius: 8,
  background: 'transparent',
} as const;

/**
 * 命盘页 —— 开源版「排盘引擎 Demo」
 *
 * 这是一个最小可运行示例：用本仓库的排盘引擎 generateChart() 配合基础 UI
 * 组件，渲染一张完整紫微命盘 + 基础解读，并支持本命 / 大限 / 流年切换。
 *
 * 另外接入了本机的「我的档案」：AI 解读结论可结构化保存，下次排盘自动带入，
 * 但档案只作背景参考，盘面与系统知识始终优先。
 */
export default function ChartPage() {
  const [chart, setChart] = useState<ZiweiChart | null>(null);
  const [selectedPalace, setSelectedPalace] = useState<Palace | null>(null);
  const [view, setView] = useState<TimeView>('mingpan');
  const [liunianYear, setLiunianYear] = useState(() => new Date().getFullYear());
  const [birthForm, setBirthForm] = useState<BirthFormState | null>(null);
  const [prefill, setPrefill] = useState<Partial<BirthFormState> | undefined>();
  const [formKey, setFormKey] = useState(0);
  const [brainOpen, setBrainOpen] = useState(false);
  const { subjects, memoriesFor } = useBrain();

  const currentFingerprint = chart ? chartFingerprint(chart) : null;
  const currentMemoryCount = currentFingerprint ? memoriesFor(currentFingerprint).length : 0;
  const profiles = subjects.filter(subject => subject.form);

  // ── 未起盘：展示出生信息表单 + 档案回填 ──
  if (!chart) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '48px 20px' }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>紫微斗数排盘</h1>
        <p style={{ color: '#888', marginBottom: 32, fontSize: 14, lineHeight: 1.7 }}>
          输入出生年月日时，开源排盘引擎即时生成命盘。
          <br />
          （本页为引擎 Demo，完整商业版界面不在开源范围；排盘内核完全开放。）
        </p>

        {profiles.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>
              我的档案 · 点击回填出生信息
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {profiles.map(profile => (
                <button
                  key={profile.fingerprint}
                  type="button"
                  onClick={() => {
                    setPrefill(profile.form);
                    setFormKey(key => key + 1);
                  }}
                  style={{ ...buttonStyle, fontSize: 12, maxWidth: '100%' }}
                >
                  {profile.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 8 }}>
              档案只保存在本机浏览器；发起 AI 解读时相关条目会发送给 AI 服务商。
            </div>
          </div>
        )}

        <BirthForm
          key={formKey}
          initialData={prefill}
          onFormSave={setBirthForm}
          onSubmit={(info: BirthInfo) => setChart(generateChart(info))}
        />

        <div style={{ marginTop: 24 }}>
          <button type="button" onClick={() => setBrainOpen(true)} style={buttonStyle}>
            我的档案管理
          </button>
        </div>

        <BrainDrawer open={brainOpen} onClose={() => setBrainOpen(false)} />
      </main>
    );
  }

  // ── 已起盘：命盘 + 解读 ──
  return (
    <main style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => { setChart(null); setSelectedPalace(null); }}
          style={buttonStyle}
        >
          ← 重新起盘
        </button>
        <button type="button" onClick={() => setBrainOpen(true)} style={buttonStyle}>
          我的档案 · {currentMemoryCount}
        </button>
      </div>

      <TimeNav
        chart={chart}
        view={view}
        liunianYear={liunianYear}
        onViewChange={setView}
        onYearChange={setLiunianYear}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          gap: 20, marginTop: 16, alignItems: 'start',
        }}
      >
        <ChartBoard
          chart={chart}
          view={view}
          liunianYear={liunianYear}
          onPalaceSelect={setSelectedPalace}
        />
        <InsightPanel
          chart={chart}
          selectedPalace={selectedPalace}
          birthForm={birthForm}
          timeView={view}
          liunianYear={liunianYear}
        />
      </div>

      <BrainDrawer
        open={brainOpen}
        onClose={() => setBrainOpen(false)}
        chart={chart}
        defaultFingerprint={currentFingerprint ?? undefined}
      />
    </main>
  );
}
