/**
 * 用户档案（brain）纯逻辑回归：
 * - 命盘指纹稳定性
 * - localStorage 读写 / 损坏备份 / 版本兼容
 * - CRUD 与条数上限
 * - 提炼结果 grounding（编造星曜、伪造原文必须被丢弃）
 * - 服务端 payload 白名单与指纹核对
 *
 * 运行：npx tsx scripts/regression/brain.test.ts
 */
import assert from 'node:assert/strict';
import { generateChart } from '../../lib/ziwei/algorithm';
import { chartFingerprint, formatSubjectLabel } from '../../lib/brain/fingerprint';
import {
  BRAIN_CORRUPT_BACKUP_KEY,
  BRAIN_LS_KEY,
  BRAIN_LIMITS,
  type BrainMemory,
  type BrainStore,
} from '../../lib/brain/types';
import {
  createEmptyStore,
  buildEvidenceContext,
  parseBrainExtraction,
  sanitizeBrainPayload,
} from '../../lib/brain/validate';
import {
  exportBrain,
  hasDuplicateConclusion,
  importBrain,
  insertMemories,
  loadBrain,
  newMemory,
  removeMemory,
  saveBrain,
  setInjectEnabled,
  updateMemory,
  upsertSubject,
  type StorageLike,
} from '../../lib/brain/storage';
import { selectBrainForInjection } from '../../lib/brain/inject';
import { formatBrainBlock } from '../../lib/brain/format';
import { asBrainContext } from '../../lib/ai/validate';

// ─── 内存版 localStorage ────────────────────────────────────
class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

// ─── 1. 指纹 ────────────────────────────────────────────────
const base = { year: 2000, month: 1, day: 1, hour: 0, gender: 'male' as const };
const chartA = generateChart(base);
const chartB = generateChart({ ...base });
assert.equal(chartFingerprint(chartA), chartFingerprint(chartB), '同盘指纹必须稳定');

const withName = generateChart({ ...base, name: '示例', province: '示例省', city: '示例市', longitude: 120 });
assert.equal(
  chartFingerprint(withName),
  chartFingerprint(chartA),
  '姓名/城市/经度不应改变指纹（经度影响已反映在 hour）',
);

assert.notEqual(
  chartFingerprint(generateChart({ ...base, gender: 'female' })),
  chartFingerprint(chartA),
  '性别必须区分',
);
assert.notEqual(
  chartFingerprint(generateChart({ ...base, hour: 5 })),
  chartFingerprint(chartA),
  '时辰必须区分',
);
assert.match(chartFingerprint(chartA), /^zz1-\d{8}-\d{1,2}-[mf]$/);
assert.match(formatSubjectLabel(withName), /示例/);

// ─── 2. 存储读写与损坏处理 ─────────────────────────────────
const storage = new MemoryStorage();
const empty = loadBrain(storage);
assert.equal(empty.store.memories.length, 0);

const fp = chartFingerprint(chartA);
const memory = newMemory({
  fingerprint: fp,
  topic: 'career',
  conclusion: '命宫天机化禄，宜从事需要思考与策划的工作。',
  evidence: [{ type: 'palace', name: '命宫' }],
  confidence: 'high',
  status: 'unverified',
  tags: ['事业'],
  source: { kind: 'interpret', question: '事业如何？', answerExcerpt: '命宫天机化禄……' },
});

let store: BrainStore = { ...empty.store, memories: [memory] };
saveBrain(store, storage);
const loaded = loadBrain(storage);
assert.equal(loaded.store.memories.length, 1);
assert.equal(loaded.store.memories[0].conclusion, memory.conclusion);

// 损坏 JSON：备份原文 + 返回空 store
storage.setItem(BRAIN_LS_KEY, '{not valid json');
const corrupted = loadBrain(storage);
assert.equal(corrupted.store.memories.length, 0);
assert.equal(storage.getItem(BRAIN_CORRUPT_BACKUP_KEY), '{not valid json');

// 更高版本：不读取、不覆盖
storage.setItem(BRAIN_LS_KEY, JSON.stringify({ version: 99, memories: [] }));
const future = loadBrain(storage);
assert.equal(future.compatible, false);

// ─── 3. CRUD 与上限 ─────────────────────────────────────────
store = createEmptyStore();
store = insertMemories(store, [memory]);
assert.equal(store.memories.length, 1);

const updated = updateMemory(store, memory.id, { status: 'confirmed' });
assert.equal(updated.memories[0].status, 'confirmed');

const removed = removeMemory(updated, memory.id);
assert.equal(removed.memories.length, 0);

const withSubject = upsertSubject(removed, {
  fingerprint: fp,
  label: '示例 · 2000-01-01 · 子时 · 男',
  createdAt: 1,
  updatedAt: 1,
});
assert.equal(withSubject.subjects[fp].label.includes('示例'), true);
assert.equal(setInjectEnabled(withSubject, false).settings.injectEnabled, false);

// 单盘上限：塞超过上限的 unverified，应淘汰最旧的 unverified
const many: BrainMemory[] = [];
for (let i = 0; i < BRAIN_LIMITS.maxMemoriesPerSubject + 5; i += 1) {
  many.push(
    newMemory({
      fingerprint: fp,
      topic: 'other',
      conclusion: `第 ${i} 条测试结论，用于验证条数上限。`,
      evidence: [{ type: 'palace', name: '命宫' }],
      confidence: 'low',
      status: i === 0 ? 'confirmed' : 'unverified',
      tags: [],
      source: { kind: 'manual' },
    }),
  );
  many[many.length - 1].updatedAt = i + 1;
}
const capped = insertMemories(createEmptyStore(), many);
assert.equal(capped.memories.length, BRAIN_LIMITS.maxMemoriesPerSubject);
assert.equal(
  capped.memories.some(item => item.conclusion === many[0].conclusion),
  true,
  '已确认条目不应先被淘汰',
);

// 导出 / 导入合并
const exported = exportBrain(capped);
const imported = importBrain(createEmptyStore(), exported);
assert.equal(imported.store.memories.length, BRAIN_LIMITS.maxMemoriesPerSubject);
assert.equal(
  hasDuplicateConclusion(imported.store, fp, many[many.length - 1].conclusion),
  true,
  '最新条目应在导入后保留',
);
assert.equal(hasDuplicateConclusion(imported.store, fp, '不存在的结论'), false);

// ─── 4. 提炼 grounding ─────────────────────────────────────
const mingPalace = chartA.palaces.find(palace => palace.name === '命宫');
assert.ok(mingPalace, '命盘必须有命宫');
const mingStar = mingPalace!.stars.find(star => star.type === 'major') ?? mingPalace!.stars[0];
assert.ok(mingStar, '命宫必须有星曜用于测试');

const answer =
  '命宫有主星坐守，事业心强，适合管理与统筹类工作。夫妻宫为太阴落陷，感情上容易多想。';
const ctx = buildEvidenceContext(chartA, undefined, answer);

const validJson = JSON.stringify({
  memories: [
    {
      topic: 'career',
      conclusion: '命宫主星坐守，事业心强，适合管理与统筹。',
      evidence: [
        { type: 'star', name: mingStar.name, palace: '命宫' },
        { type: 'answer', quote: '事业心强' },
      ],
      confidence: 'high',
    },
    {
      // 编造星曜：必须整条丢弃
      topic: 'wealth',
      conclusion: '命宫有天魁星，偏财极旺。',
      evidence: [{ type: 'star', name: '天魁不存在的星' }],
      confidence: 'high',
    },
    {
      // 伪造原文 quote：该证据被丢弃，但还有合法宫位证据，条目保留
      topic: 'love',
      conclusion: '夫妻宫太阴落陷，感情上容易多想。',
      evidence: [
        { type: 'answer', quote: '这句话原文里没有' },
        { type: 'palace', name: '夫妻宫' },
      ],
      confidence: 'medium',
    },
    {
      // 完全没有依据：整条丢弃
      topic: 'health',
      conclusion: '肠胃偏弱。',
      evidence: [],
      confidence: 'low',
    },
  ],
});

const parsed = parseBrainExtraction(validJson, ctx);
assert.equal(parsed.error, undefined);
assert.equal(parsed.memories.length, 2, `应保留 2 条，实际 ${parsed.memories.length}`);
assert.equal(parsed.memories[0].topic, 'career');
assert.equal(parsed.memories[1].topic, 'love');
assert.equal(
  parsed.memories[1].evidence.some(item => item.type === 'answer'),
  false,
  '伪造原文引用必须被剔除',
);

// 中文枚举兼容
const cnJson = JSON.stringify({
  memories: [
    {
      topic: '事业',
      conclusion: '命宫主星坐守，宜管理与统筹。',
      evidence: [{ type: 'star', name: mingStar.name, palace: '命宫' }],
      confidence: '高',
    },
  ],
});
const cnParsed = parseBrainExtraction(cnJson, ctx);
assert.equal(cnParsed.memories.length, 1);
assert.equal(cnParsed.memories[0].topic, 'career');
assert.equal(cnParsed.memories[0].confidence, 'high');

// JSON 坏掉
assert.ok(parseBrainExtraction('抱歉，我不能输出 JSON。', ctx).error);

// ─── 5. 服务端 payload 白名单 ───────────────────────────────
const payload = {
  fingerprint: fp,
  memories: [
    {
      id: 'test-1',
      topic: 'career',
      conclusion: '命宫主星坐守，事业心强。',
      evidence: [{ type: 'star', name: mingStar.name, palace: '命宫' }],
      confidence: 'high',
      status: 'confirmed',
      updatedAt: 1,
      // 以下字段不在白名单，必须被丢弃
      source: { kind: 'interpret', answerExcerpt: '不应发送' },
      tags: ['私密标签'],
    },
  ],
};

const payloadCtx = buildEvidenceContext(chartA);
const accepted = sanitizeBrainPayload(payload, fp, payloadCtx);
assert.ok(accepted);
assert.equal(accepted!.memories.length, 1);
assert.equal('source' in accepted!.memories[0], false, 'payload 不应包含 source');
assert.equal('tags' in accepted!.memories[0], false, 'payload 不应包含 tags');

assert.equal(sanitizeBrainPayload(payload, 'zz1-00000000-0-m', payloadCtx), null, '指纹不符必须拒绝');
assert.equal(
  sanitizeBrainPayload({ ...payload, memories: [{ ...payload.memories[0], evidence: [{ type: 'star', name: '编造星' }] }] }, fp, payloadCtx),
  null,
  '全部证据被拒绝时 payload 应整体无效',
);

// ─── 6. 注入排序 / 预算 / 档案区块 ──────────────────────────
function makeMemory(
  id: string,
  overrides: Partial<BrainMemory> = {},
): BrainMemory {
  return {
    id,
    fingerprint: fp,
    topic: 'career',
    conclusion: '测试结论',
    evidence: [{ type: 'palace', name: '命宫' }],
    confidence: 'medium',
    status: 'unverified',
    tags: [],
    source: { kind: 'manual' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const careerConfirmed = makeMemory('career-confirmed', {
  topic: 'career',
  conclusion: '命宫主星强，适合管理类工作。',
  evidence: [{ type: 'palace', name: '命宫' }],
  confidence: 'high',
  status: 'confirmed',
  updatedAt: Date.now(),
});
const loveUnverified = makeMemory('love-unverified', {
  topic: 'love',
  conclusion: '夫妻宫星曜组合，感情上宜晚婚。',
  evidence: [{ type: 'palace', name: '夫妻宫' }],
  confidence: 'low',
  status: 'unverified',
  updatedAt: Date.now() - 1000,
});
const wealthRefuted = makeMemory('wealth-refuted', {
  topic: 'wealth',
  conclusion: '三十岁前必破财。',
  evidence: [{ type: 'palace', name: '财帛' }],
  status: 'refuted',
  updatedAt: Date.now() - 2000,
});

const injected = selectBrainForInjection(
  [loveUnverified, wealthRefuted, careerConfirmed],
  { chart: chartA, question: '我的事业和命宫怎么样？', palaceName: '命宫' },
);
assert.deepEqual(
  injected.memories.map(memory => memory.id),
  ['career-confirmed', 'love-unverified'],
  '已确认 + 相关主题应排前面',
);
assert.deepEqual(injected.refuted.map(memory => memory.id), ['wealth-refuted']);
assert.equal(
  injected.memories.some(memory => memory.status === 'refuted'),
  false,
  '已推翻条目不得进入正向档案',
);

// 预算：不超过条数上限
const manyForInject = Array.from({ length: BRAIN_LIMITS.maxInjectItems + 5 }, (_, index) =>
  makeMemory(`bulk-${index}`, {
    conclusion: `第 ${index} 条较长的测试结论，用于验证注入预算截断是否生效。`,
    updatedAt: Date.now() - index * 1000,
  }),
);
const budgeted = selectBrainForInjection(manyForInject, { chart: chartA });
assert.ok(budgeted.memories.length <= BRAIN_LIMITS.maxInjectItems);

const block = formatBrainBlock({
  subjectLabel: '测试对象',
  memories: injected.memories,
  refuted: injected.refuted,
});
assert.match(block, /用户档案/);
assert.match(block, /档案使用规则/);
assert.match(block, /档案不是紫微斗数规则|不是盘面证据/);
assert.match(block, /已推翻（不得重复）/);
assert.equal(formatBrainBlock({ memories: [], refuted: [] }), '', '无档案时应返回空字符串');

// ─── 7. 时间视图 context 校验 ───────────────────────────────
const timeCtx = asBrainContext(
  { topic: 'career', palace: '命宫', timeView: 'liunian', year: 2027 },
  chartA,
);
assert.equal(timeCtx?.timeView, 'liunian');
assert.equal(timeCtx?.year, 2027);
assert.equal(timeCtx?.palace, '命宫');

const outOfRange = asBrainContext({ timeView: 'liunian', year: 1800 }, chartA);
assert.equal(outOfRange?.timeView, 'liunian');
assert.equal(outOfRange?.year, undefined, '越界年份应被忽略');
assert.equal(asBrainContext({ timeView: 'liunian', year: 2027 }, chartA)?.year, 2027);
assert.equal(asBrainContext({ timeView: 'bogus', year: 2027 }, chartA), null, '非法视图应被忽略');
assert.equal(asBrainContext({ palace: '不存在的宫' }, chartA), null, '不存在的宫位应被忽略');

console.log('✓ brain: fingerprint / storage / grounding / payload / inject / time-context 全部通过');
