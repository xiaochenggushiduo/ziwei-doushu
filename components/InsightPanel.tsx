'use client';
import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ZiweiChart, Palace } from '@/lib/ziwei/types';
import type { TimeView } from './TimeNav';
import { consumeSse, readErrorMessage } from '@/lib/sse-client';
import { chartFingerprint } from '@/lib/brain/fingerprint';
import { loadBrain } from '@/lib/brain/storage';
import type { BrainMemoryDraft, BrainPayload } from '@/lib/brain/types';
import { normalizeForDedupe } from '@/lib/brain/validate';
import { useBrain } from '@/lib/brain/use-brain';
import type { BirthFormState } from './BirthForm';
import BrainCaptureSheet from './BrainCaptureSheet';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  hidden?: boolean; // don't show user bubble for auto/topic messages
  /** 该回答对应的用户问题（用于档案溯源） */
  question?: string;
  /** 是否为错误提示消息（不显示“记住这条”） */
  error?: boolean;
}

interface SelectedSiHua {
  starName: string;
  siHua: string;
  view: TimeView;
}

interface InsightPanelProps {
  chart: ZiweiChart;
  selectedPalace?: Palace | null;
  selectedSiHua?: SelectedSiHua | null;
  /** 当前排盘表单，保存档案时一并记住出生信息，便于下次回填 */
  birthForm?: BirthFormState | null;
  /** 盘面当前的时间视图，让解读跟随用户正在看的流年/大限 */
  timeView?: TimeView;
  liunianYear?: number;
}

/** 与服务端 lib/ai/validate.ts 的 MAX_MESSAGES 保持一致 */
const MAX_DIALOGUE_MESSAGES = 30;

const TOPICS = [
  { key: 'overview',     label: '命格' },
  { key: 'love',        label: '感情' },
  { key: 'career',      label: '事业' },
  { key: 'wealth',      label: '财运' },
  { key: 'health',      label: '健康' },
  { key: 'personality', label: '性格' },
] as const;

const TOPIC_PROMPTS: Record<string, string> = {
  overview: `请生成命格总览，按以下结构输出：

**【命格定性】**
用一句话概括这个命盘的核心格局与命主气质。

**【主星解读】**
命宫主星的核心特质，引用倪海厦原话或观点。

**【三方四正】**
财、官、迁三宫的联动分析及整体格局。

**【当前大限】**
当下大限运势方向与最值得关注的事项。

**【优势与注意】**
命盘天赋优势，以及需要注意的风险或功课。`,

  love: `请深度分析感情婚姻运，按以下结构输出：

**【感情格局】**
一句话定性感情命格。

**【夫妻宫分析】**
夫妻宫主星、四化，以及倪海厦体系的具体解读。

**【三方联动】**
相关宫位对感情的影响。

**【当前大限感情运】**
当下10年感情走向与关键节点。

**【实际建议】**
具体可行的感情建议。`,

  career: `请深度分析事业运，按以下结构输出：

**【事业格局】**
一句话定性事业命格，宜任职或宜创业。

**【官禄宫分析】**
官禄宫主星、四化，以及倪师对这种配置的判断。

**【财帛宫联动】**
财运与事业的关系，财路来源分析。

**【当前大限事业运】**
当下10年事业走向。

**【实际建议】**
适合的方向、行业与策略。`,

  wealth: `请深度分析财运，按以下结构输出：

**【财运格局】**
一句话定性财运模式，是主动财还是被动财。

**【财帛宫分析】**
财帛宫主星、四化，财富来源与流动模式。

**【田宅宫（财库）】**
积蓄能力与不动产运势分析。

**【当前大限财运】**
当下财运走向与注意事项。

**【理财建议】**
具体的财务建议。`,

  health: `请分析健康运势，按以下结构输出：

**【疾厄宫主星】**
疾厄宫星曜与健康含义。

**【主要风险】**
结合倪海厦子午流注理论，分析主要健康隐患与需关注的部位。

**【大限健康走势】**
当下健康趋势与关键时间段。

**【预防建议】**
具体注意事项与养生方向。`,

  personality: `请深度解析性格特质，按以下结构输出：

**【命宫主星性格】**
命宫主星的核心性格特质，引用倪师原话。

**【三方性格综合】**
财、官、迁三宫对性格的影响，全貌描绘。

**【人际关系模式】**
与他人互动方式、待人处世风格。

**【优势与人生课题】**
天赋优势，以及需要面对的人生功课。`,
};

const PALACE_ROLES: Record<string, string> = {
  '命宫':   '自我、性格、先天格局',
  '兄弟宫': '兄弟关系、合伙人',
  '夫妻宫': '感情关系、婚姻状态',
  '子女宫': '子女缘分、下属关系',
  '财帛宫': '财运来源、收入方式',
  '疾厄宫': '身体健康、意外',
  '迁移宫': '外出机遇、人际格局',
  '交友宫': '朋友圈、贵人、小人',
  '官禄宫': '事业成就、社会地位',
  '田宅宫': '不动产、家庭环境',
  '福德宫': '精神享受、内心福分',
  '父母宫': '父母关系、文书契约',
};

/** Render AI markdown: **【Title】** → gold header, **bold** → strong */
function AiContent({ text, streaming }: { text: string; streaming?: boolean }) {
  const lines = text.split('\n');
  return (
    <div className="space-y-0.5">
      {lines.map((line, i) => {
        const sectionMatch = line.match(/^\*\*【(.+?)】\*\*$/);
        if (sectionMatch) {
          return (
            <div key={i} className="pt-3 pb-0.5 first:pt-0">
              <span className="text-[11px] font-semibold tracking-wide" style={{ color: 'var(--t-gold)' }}>
                【{sectionMatch[1]}】
              </span>
            </div>
          );
        }
        if (line.trim() === '') return <div key={i} className="h-1" />;
        const parts = line.split(/\*\*(.+?)\*\*/);
        return (
          <div key={i} className="text-[11px] leading-relaxed" style={{ color: 'var(--t-text2)' }}>
            {parts.map((part, j) =>
              j % 2 === 0
                ? part
                : <strong key={j} className="font-medium" style={{ color: 'var(--t-text)' }}>{part}</strong>
            )}
          </div>
        );
      })}
      {streaming && (
        <span
          className="inline-block w-1.5 h-3 ml-0.5 animate-pulse rounded-sm align-middle"
          style={{ background: 'var(--t-gold)', opacity: 0.6 }}
        />
      )}
    </div>
  );
}

export default function InsightPanel({
  chart,
  selectedPalace,
  selectedSiHua,
  birthForm,
  timeView = 'mingpan',
  liunianYear,
}: InsightPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeTopic, setActiveTopic] = useState<string>('overview');
  const [capturing, setCapturing] = useState<number | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureDrafts, setCaptureDrafts] = useState<BrainMemoryDraft[]>([]);
  const [captureWarnings, setCaptureWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const { addMemories, rememberSubject, memoriesFor } = useBrain();
  const fingerprint = chartFingerprint(chart);
  const messagesRef = useRef<Message[]>([]); // always-current copy for closures
  const loadingRef = useRef(false);
  const autoLoaded = useRef(false);
  const lastPalaceBranch = useRef<number | undefined>(undefined);
  const lastSiHuaKey = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep refs in sync
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Auto-generate 命格总览 on mount
  useEffect(() => {
    if (autoLoaded.current) return;
    autoLoaded.current = true;
    sendMessage(TOPIC_PROMPTS.overview, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Inject palace analysis when palace selected
  useEffect(() => {
    if (!selectedPalace || selectedPalace.branch === lastPalaceBranch.current) return;
    lastPalaceBranch.current = selectedPalace.branch;

    const majorStars = selectedPalace.stars.filter(s => s.type === 'major');
    const starDesc = majorStars.length > 0
      ? majorStars.map(s => `${s.name}${s.siHua ? '化' + s.siHua : ''}`).join('、')
      : '空宫（借对宫）';
    const role = PALACE_ROLES[selectedPalace.name] ?? '';

    const prompt = `请重点分析【${selectedPalace.name}】（主管：${role}），该宫主星为${starDesc}，按以下结构输出：

**【宫位定性】**
${selectedPalace.name}在命盘中的意义，以及这种星曜配置的整体判断。

**【主星解读】**
主星在此宫的倪海厦体系解读，引用具体观点。

**【三方四正联动】**
三方四正宫位对此宫的影响。

**【实际建议】**
基于此宫的具体建议。`;

    sendMessage(prompt, true);
  }, [selectedPalace]); // eslint-disable-line react-hooks/exhaustive-deps

  // 注入四化飞化分析
  useEffect(() => {
    if (!selectedSiHua) return;
    const key = `${selectedSiHua.starName}-${selectedSiHua.siHua}-${selectedSiHua.view}`;
    if (key === lastSiHuaKey.current) return;
    lastSiHuaKey.current = key;

    // 找出该星所在宫位
    const palaceOfStar = chart.palaces.find(p =>
      p.stars.some(s => s.name === selectedSiHua.starName)
    );
    const palaceName = palaceOfStar?.name ?? '未知宫位';
    const viewLabel = selectedSiHua.view === 'daxian' ? '大限' : '流年';

    const prompt = `请分析【${viewLabel}${selectedSiHua.starName}化${selectedSiHua.siHua}】的飞化影响，按以下结构输出：

**【化${selectedSiHua.siHua}基本含义】**
化${selectedSiHua.siHua}在倪海厦体系中的核心含义，以及${selectedSiHua.starName}化${selectedSiHua.siHua}的特殊含义。

**【落宫影响】**
${selectedSiHua.starName}化${selectedSiHua.siHua}落在【${palaceName}】，该宫主管的领域受到何种影响，倪师如何解读。

**【三方四正飞化路径】**
化${selectedSiHua.siHua}入${palaceName}后，对其三方四正（对宫、两个三合宫）的联动影响。

**【当前运势影响】**
在${viewLabel}时间维度下，此化${selectedSiHua.siHua}对命主近期运势的具体影响。

**【实际建议】**
基于此四化的具体可操作建议。`;

    sendMessage(prompt, true);
  }, [selectedSiHua]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 每次请求前同步读取本地档案，避免挂载时 hook 快照尚未就绪 */
  const buildBrainPayload = (): BrainPayload | undefined => {
    try {
      const { store } = loadBrain();
      if (!store.settings.injectEnabled) return undefined;
      const fingerprint = chartFingerprint(chart);
      const memories = store.memories.filter(memory => memory.fingerprint === fingerprint);
      if (!memories.length) return undefined;
      return {
        fingerprint,
        memories: memories.map(memory => ({
          id: memory.id,
          topic: memory.topic,
          conclusion: memory.conclusion,
          evidence: memory.evidence,
          confidence: memory.confidence,
          status: memory.status,
          updatedAt: memory.updatedAt,
        })),
      };
    } catch {
      return undefined;
    }
  };

  const streamResponse = async (
    apiMessages: { role: 'user' | 'assistant'; content: string }[],
    question?: string,
  ) => {
    try {
      const res = await fetch('/api/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chart,
          messages: apiMessages,
          brain: buildBrainPayload(),
          context: {
            topic: activeTopic === 'overview' ? undefined : activeTopic,
            palace: selectedPalace?.name,
            timeView,
            year: timeView === 'liunian' ? liunianYear : undefined,
          },
        }),
      });
      if (res.status === 404) throw new Error('api-missing');
      if (!res.ok) throw new Error(await readErrorMessage(res));
      if (!res.body) throw new Error('无响应流');

      let assistantText = '';

      setMessages(prev => [...prev, { role: 'assistant', content: '', question }]);

      await consumeSse(res, delta => {
        assistantText += delta;
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: assistantText, question };
          return updated;
        });
      });
    } catch (e) {
      const missing = e instanceof Error && e.message === 'api-missing';
      setMessages(prev => [...prev, {
        role: 'assistant',
        error: true,
        content: missing
          ? '开源版不含 AI 解读接口（/api/interpret），需要你自己实现后才能用，详见 README「快速开始」。排盘本身不需要任何 API Key。'
          : e instanceof Error && e.message
            ? e.message
            : '解读失败，请稍后重试。',
      }]);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  };

  const startNewChat = () => {
    if (loadingRef.current) return;
    messagesRef.current = [];
    setMessages([]);
    setInput('');
    setNotice('已开始新对话');
    setTimeout(() => setNotice(''), 2000);
  };

  const sendMessage = (text: string, hidden = false) => {
    if (!text.trim() || loadingRef.current) return;
    // 服务端上限 30 条；提前拦截，避免请求后才发现
    if (messagesRef.current.length >= MAX_DIALOGUE_MESSAGES) {
      setNotice('本对话已达 30 条上限，请点「新对话」后继续。');
      return;
    }
    loadingRef.current = true;
    setLoading(true);

    const userMsg: Message = { role: 'user', content: text, hidden };
    // Capture current messages synchronously via ref (avoids stale closure)
    const apiMessages = [...messagesRef.current, userMsg].map(m => ({
      role: m.role,
      content: m.content,
    }));

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    // 隐藏的结构化 prompt 不适合作为“当时的问题”留档，只有真实追问才记录
    streamResponse(apiMessages, hidden ? undefined : text.trim().slice(0, 500));
  };

  const handleRemember = async (index: number) => {
    const message = messages[index];
    if (!message || message.role !== 'assistant' || message.error || capturing !== null) return;

    setCapturing(index);
    setNotice('');
    try {
      const res = await fetch('/api/brain/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart, answer: message.content, question: message.question }),
      });
      if (!res.ok) {
        setNotice((await readErrorMessage(res)) || '提炼失败，请重试或手动整理');
        return;
      }
      const data = (await res.json()) as {
        memories?: BrainMemoryDraft[];
        warnings?: string[];
      };
      if (!data.memories?.length) {
        setNotice(data.warnings?.[0] ?? '这段回答里没有可长期保存的结构化结论');
        return;
      }
      setCaptureDrafts(data.memories);
      setCaptureWarnings(data.warnings ?? []);
      setCaptureOpen(true);
    } catch {
      setNotice('提炼失败，请检查网络或 AI 配置');
    } finally {
      setCapturing(null);
    }
  };

  const handleCaptureSave = (drafts: BrainMemoryDraft[]) => {
    try {
      const inserted = addMemories(
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
      rememberSubject(chart, birthForm ?? undefined);
      setCaptureOpen(false);
      setNotice(`已存入档案 ${inserted.length} 条`);
      setTimeout(() => setNotice(''), 4000);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '档案保存失败，请先导出并清理旧条目');
    }
  };

  const handleTopicClick = (topicKey: string) => {
    if (loadingRef.current) return;
    setActiveTopic(topicKey);
    sendMessage(TOPIC_PROMPTS[topicKey], true);
  };

  const handleSend = () => {
    sendMessage(input);
  };

  return (
    <div className="flex flex-col h-[min(44rem,80dvh)] min-h-0 min-w-0 rounded-xl overflow-hidden card-glass">

      {/* ── 对话工具条：当前时间视图 / 轮次计数 / 新对话 ── */}
      <div className="flex-shrink-0 px-3 pt-2 flex items-center gap-2">
        <span
          className="px-1.5 py-0.5 rounded text-[9px]"
          style={{ background: 'rgba(212,168,67,0.08)', color: 'var(--t-gold)' }}
          title="AI 解读会参考当前盘面视图"
        >
          {timeView === 'mingpan' ? '本命' : timeView === 'daxian' ? '当前大限' : `流年 ${liunianYear ?? ''}`}
        </span>
        <span
          className="text-[9px] ml-auto"
          style={{ color: messages.length >= MAX_DIALOGUE_MESSAGES ? '#f59e0b' : 'var(--t-faint)' }}
        >
          对话 {messages.length}/{MAX_DIALOGUE_MESSAGES}
        </span>
        <button
          onClick={startNewChat}
          disabled={loading || !messages.length}
          className="px-2 py-1 rounded-md text-[9px] disabled:opacity-30"
          style={{ border: '1px solid var(--t-border)', color: 'var(--t-gold)' }}
          title="清空当前对话，开始新的解读"
        >
          新对话
        </button>
      </div>

      {/* ── Topic buttons ── */}
      <div className="flex-shrink-0 px-2 pt-2.5 pb-2" style={{ borderBottom: '1px solid var(--t-border)' }}>
        <div className="grid grid-cols-6 gap-1">
          {TOPICS.map(t => {
            const isActive = activeTopic === t.key;
            return (
              <button
                key={t.key}
                onClick={() => handleTopicClick(t.key)}
                disabled={loading}
                className="py-1.5 text-[10px] font-medium rounded-lg transition-all duration-150 disabled:opacity-40"
                style={{
                  background: isActive ? 'rgba(212,168,67,0.12)' : 'transparent',
                  border: `1px solid ${isActive ? 'rgba(212,168,67,0.3)' : 'var(--t-border)'}`,
                  color: isActive ? 'var(--t-gold)' : 'var(--t-faint)',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Messages ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">

        {/* Loading state before first message */}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-4xl mb-3" style={{ color: 'var(--t-gold)', opacity: 0.1 }}>✦</div>
            <p className="text-[10px] animate-pulse" style={{ color: 'var(--t-faint)' }}>命格解读生成中…</p>
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((msg, i) => {
            if (msg.role === 'user' && msg.hidden) return null;

            if (msg.role === 'user') {
              return (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex justify-end"
                >
                  <div
                    className="max-w-[85%] rounded-xl px-3 py-2 text-[11px]"
                    style={{
                      background: 'rgba(212,168,67,0.08)',
                      border: '1px solid rgba(212,168,67,0.18)',
                      color: 'var(--t-gold)',
                    }}
                  >
                    {msg.content}
                  </div>
                </motion.div>
              );
            }

            // Assistant message
            const isLastMsg = i === messages.length - 1;
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div
                  className="text-[9px] tracking-widest mb-2 flex items-center gap-1.5"
                  style={{ color: 'var(--t-faint)' }}
                >
                  <span style={{ color: 'var(--t-gold)', opacity: 0.4 }}>✦</span>
                  命理解读
                </div>
                <AiContent text={msg.content} streaming={loading && isLastMsg} />
                {!(loading && isLastMsg) && !msg.error && (
                  <div className="mt-1.5 flex justify-end">
                    <button
                      onClick={() => handleRemember(i)}
                      disabled={capturing !== null}
                      className="px-2 py-1 rounded-md text-[9px] transition-colors disabled:opacity-30"
                      style={{ border: '1px solid var(--t-border)', color: 'var(--t-faint)' }}
                    >
                      {capturing === i ? '整理中…' : '＋ 记住这条'}
                    </button>
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {notice && (
        <div className="flex-shrink-0 px-3 pb-1 text-[10px]" style={{ color: 'var(--t-gold)' }}>
          {notice}
        </div>
      )}

      {/* ── Input ── */}
      <div className="flex-shrink-0 px-3 pb-3 pt-2" style={{ borderTop: '1px solid var(--t-border)' }}>
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="继续追问，如：今年适合换工作吗？"
            disabled={loading}
            className="flex-1 rounded-lg px-3 py-2 text-[11px] focus:outline-none transition-colors"
            style={{
              background: 'var(--t-card)',
              border: '1px solid var(--t-border)',
              color: 'var(--t-text)',
            }}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="px-3 py-2 rounded-lg text-[11px] font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: 'rgba(212,168,67,0.15)',
              border: '1px solid rgba(212,168,67,0.25)',
              color: 'var(--t-gold)',
            }}
          >
            {loading ? '…' : '追问'}
          </button>
        </div>
      </div>

      <BrainCaptureSheet
        open={captureOpen}
        chart={chart}
        drafts={captureDrafts}
        warnings={captureWarnings}
        existingConclusions={
          new Set(memoriesFor(fingerprint).map(memory => normalizeForDedupe(memory.conclusion)))
        }
        onClose={() => setCaptureOpen(false)}
        onSave={handleCaptureSave}
      />

    </div>
  );
}
