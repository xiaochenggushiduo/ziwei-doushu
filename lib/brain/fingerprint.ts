import type { ZiweiChart } from '@/lib/ziwei/types';
import { BRANCHES } from '@/lib/ziwei/constants';

/**
 * 命盘指纹：把「同一张盘」归一成一个稳定 key。
 *
 * 组成只用排盘后真正决定盘面的字段：
 * - year/month/day：已经是晚子时换日后的排盘日
 * - hour：真太阳时校正后的时辰地支索引 (0-11)
 * - gender：性别
 *
 * 不用姓名/城市/经度/原始输入：
 * - 姓名只是标签，改名不应让档案“丢失”；
 * - 经度的影响已经反映在 hour 里；
 * - origInput 当前从未写入，不能作为依据。
 *
 * 版本前缀 zz1：将来调整字段或排盘口径时升为 zz2，便于迁移识别。
 */
export function chartFingerprint(chart: Pick<ZiweiChart, 'birthInfo'>): string {
  const b = chart.birthInfo;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${b.year}${pad(b.month)}${pad(b.day)}`;
  const gender = b.gender === 'male' ? 'm' : 'f';
  return `zz1-${date}-${b.hour}-${gender}`;
}

/** 仅用于 UI 展示的主体标签，不参与指纹 */
export function formatSubjectLabel(chart: Pick<ZiweiChart, 'birthInfo'>): string {
  const b = chart.birthInfo;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${b.year}-${pad(b.month)}-${pad(b.day)}`;
  const shichen = `${BRANCHES[b.hour] ?? '?'}时`;
  const gender = b.gender === 'male' ? '男' : '女';
  return [b.name, date, shichen, gender].filter(Boolean).join(' · ');
}
