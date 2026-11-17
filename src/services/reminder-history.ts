/**
 * 提醒历史的展示层纯函数（P1-02 / v0.14.0）—— 刻意不碰数据库与 React。
 *
 * # 为什么单独一个模块
 *
 * 提醒中心要回答的唯一问题是「提醒过什么」。数据库里是扁平的行，直接渲染会出现
 * 两类失真：① v0.11.0 的合并交付（一次长休眠恢复把 N 条过期提醒合成一条弹窗）
 * 在历史里散成 N 行，用户看不出"它们是一起响的"；② 「再次提醒」的时间推算散在
 * UI 里没法单测。这两件事都是纯逻辑，抽出来用单测钉死边界，Tab 组件只管渲染。
 *
 * # 合并批次的判定
 *
 * 合并交付时调度器给同一批行写同一个 `batch_id`（v0.14.0 新增列）。**只按 batch_id
 * 聚合、不按 fired_at 相等聚合**：两条独立提醒也可能恰好在同一毫秒被认领
 * （调度循环里 `Date.now()` 返回同一个值），按时间聚合会把它们误标成"合并交付"。
 */

import type { Reminder } from "@/services/reminders";

/** 历史列表的一个条目：单条，或一次合并交付的整批 */
export type HistoryEntry =
  | { kind: "single"; reminder: Reminder }
  | { kind: "batch"; fireAt: number; items: Reminder[] };

/**
 * 历史排序键：与 SQL 的 `ORDER BY COALESCE(fired_at, created_at) DESC` 对齐——
 * fired 行按实际触发时间、cancelled 行按创建时间（取消没有独立的 cancelled_at 列）。
 * UI 侧合并补齐批次行时也要按同一个键重排，纯函数暴露出来供测试与调用方共用。
 */
export function historySortKey(reminder: Reminder): number {
  return reminder.firedAt ?? reminder.createdAt;
}

/**
 * 把按历史序排好的行聚合成展示条目。
 *
 * 只合并 **相邻且 batch_id 相同** 的行（批次成员在 SQL 排序下天然相邻）；
 * batch_id 为 NULL 的行（包括同毫秒触发的独立提醒）永远保持单条。
 * 输入顺序不满足"批次相邻"时（理论上不该发生）宁可拆开显示，也不跨段聚合——
 * 拆开只是难看，错聚合会撒谎。
 */
export function groupHistoryRows(rows: Reminder[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let pending: Reminder[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    entries.push(
      pending.length === 1
        ? { kind: "single", reminder: pending[0] }
        : { kind: "batch", fireAt: historySortKey(pending[0]), items: pending },
    );
    pending = [];
  };
  for (const row of rows) {
    const head = pending[0];
    if (head && row.batchId && head.batchId === row.batchId) {
      pending.push(row);
    } else {
      flush();
      pending = [row];
    }
  }
  flush();
  return entries;
}

/** 「再次提醒 · 30 分钟后」的目标时刻：从现在起算，与用户看到按钮的时刻对齐 */
export function snoozePlus30(now: number): number {
  return now + 30 * 60 * 1000;
}

/**
 * 「再次提醒 · 明天同一时间」的目标时刻：明天的本地日历日期 + 原提醒的本地时分秒。
 *
 * 与 recurrence.ts 的 nextOccurrence 同一哲学：用 `setDate/setHours` 在**本地日历**上
 * 推进，不做 `+86400000` 毫秒加法（夏令时切换日会偏一小时）。结果必然晚于 now
 * （明天的任何时刻都在未来），无需再校验。
 *
 * @returns epoch ms；任一输入不是有限数字返回 null（脏数据降级为不显示按钮）
 */
export function tomorrowSameTime(now: number, fireAt: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(fireAt)) return null;
  const source = new Date(fireAt);
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  target.setHours(source.getHours(), source.getMinutes(), source.getSeconds(), source.getMilliseconds());
  return target.getTime();
}
