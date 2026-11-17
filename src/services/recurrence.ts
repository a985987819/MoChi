/**
 * 周期提醒的下一次推算（v0.13.0）—— 纯函数，刻意不碰数据库与设置。
 *
 * # 为什么单独一个模块
 *
 * "下一次是什么时候"是这套功能里唯一**真正容易算错**的部分：跨日、跨周末、跨夏令时、
 * 关机几天后的补发，每一种都能写出一个看似对、实际偏一小时的实现。把它抽成纯函数，
 * 单测就能把这些边界钉死，调度器只负责调用。
 *
 * # 语义（写下来避免各自理解不同）
 *
 * - `repeat`：`none` 一次性 / `daily` 每天 / `weekdays` 工作日（周一~周五）/ `weekly` 每周同一天；
 * - **时区**：以**本地日历**推进（`setDate`），不用 `+86400000` 毫秒加法——
 *   后者在夏令时切换日会偏一小时（有夏令时的地区实打实会遇到）；
 * - **触发时刻**：保留原 fire_at 的时分（"每天 9:00"永远 9:00，而不是"上次触发时刻 + 24h"）；
 * - **补发**：`after` 传"现在"，函数会一路推进到**第一个晚于 now** 的时刻——
 *   关机三天后开机只补一次，然后落到下一个未来时刻（与 docs/learning/08 §5.4 一致）。
 */

export type Repeat = "none" | "daily" | "weekdays" | "weekly";

/** 允许的取值（工具参数校验、UI 下拉、DB 读回都用它，避免三处各写一份） */
export const REPEAT_VALUES: readonly Repeat[] = ["none", "daily", "weekdays", "weekly"];

/** DB 里的字符串 → Repeat；未知值按一次性处理（旧库/脏数据的兜底） */
export function parseRepeat(value: unknown): Repeat {
  return typeof value === "string" && (REPEAT_VALUES as readonly string[]).includes(value)
    ? (value as Repeat)
    : "none";
}

/** 在本地日历上加减天数（保留时分秒；跨月/跨年由 Date 自己处理） */
function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/**
 * 从本次的 `fireAt` 推算下一次**严格晚于 `after`** 的触发时刻；`none` 或算不出来返回 null。
 *
 * @param fireAt 本次（已触发或将要触发）的时刻
 * @param repeat 重复规则
 * @param after  通常传 `Date.now()`；测试里传"模拟的现在"以便断言
 */
export function nextOccurrence(fireAt: number, repeat: Repeat, after: number): number | null {
  if (repeat === "none" || !Number.isFinite(fireAt)) return null;
  const step = repeat === "weekly" ? 7 : 1;
  let cursor = new Date(fireAt);
  // 上限 1000 次迭代：daily 能覆盖近三年，weekly 能覆盖近二十年；
  // 超出说明数据异常（或用户真的关机三年），返回 null 比死循环安全。
  for (let guard = 0; guard < 1000; guard += 1) {
    cursor = addDays(cursor, step);
    if (repeat === "weekdays") {
      // 周末再往后挪：周五触发后下一次是下周一，而不是周六
      while (isWeekend(cursor)) cursor = addDays(cursor, 1);
    }
    if (cursor.getTime() > after) return cursor.getTime();
  }
  return null;
}
