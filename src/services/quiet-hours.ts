/**
 * 免打扰时段（v0.10.0）—— 「不打扰人的礼貌」第一条。
 *
 * # 为什么需要它
 *
 * 桌宠最招人烦的不是功能少，是**在不该出现的时候出现**：夜里十一点半弹「该站起来啦」。
 * v0.9.0 只有托盘里那句「暂停 1 小时」，第二天还得手动再暂停一次。
 *
 * # 作用范围（刻意收窄）
 *
 * 只静默**站立提醒**（它是系统自动生成的、不看时间也该懂的打扰）。
 * 用户自己定的**自定义提醒**与**番茄钟**照常响：那是"我要求这个点响"，静默它们
 * 等于把用户的明确指令吞掉——这比打扰更糟。
 *
 * # 边界语义
 *
 * - `startHour > endHour` 表示**跨午夜**（22 点 → 次日 8 点）；
 * - `startHour === endHour` 视为**未设置**（返回 false）——否则会变成全天静音，
 *   这是最容易由滑块/下拉误配出来的"沉默故障"，明确排除。
 *
 * 纯函数（不碰 Tauri、不读设置），单测覆盖跨午夜、边界时刻与等值退化。
 */

/** 时段内的小时判断；[startHour, endHour) 左闭右开——22 点整开始静默，8 点整恢复 */
export function isQuietHour(now: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  const hour = new Date(now).getHours();
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

/**
 * 当前免打扰时段的**结束时刻**（epoch ms）。不在时段内返回 null。
 *
 * 站立提醒用它把截止时间推到静默结束：既不会半夜响，也不会在静默结束后
 * 因为"攒了几小时的欠账"连弹多次——只有一个新的截止点。
 */
export function quietEndAt(now: number, startHour: number, endHour: number): number | null {
  if (!isQuietHour(now, startHour, endHour)) return null;
  const end = new Date(now);
  end.setHours(endHour, 0, 0, 0);
  // 跨午夜的情形（22→8）：今天 8 点已经过去，结束时刻在明天 8 点
  if (end.getTime() <= now) end.setDate(end.getDate() + 1);
  return end.getTime();
}
