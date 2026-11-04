/**
 * 番茄钟状态机的**纯迁移决策**（v0.9.0 Night 5 从 PomodoroService.tick 抽出）。
 *
 * # 为什么抽出来
 *
 * PomodoroService 顶层 import @tauri-apps/api/event（广播/监听），vitest 跑在
 * node 环境——服务类无法直接单测。阶段迁移是计时系统里最容易回归的决策
 * （learning/08 §4.3：休息结束**不自动续轮**是产品承诺），把它抽成纯函数：
 * 服务类只剩「查表执行副作用」，决策逻辑获得机械保证。
 *
 * # 状态机（learning/08 §4.3）
 *
 *   idle ──start──▶ focus ──到点──▶ break ──到点──▶ idle（不自动续轮！）
 *
 * 时间基准三原则（08 §4.1）：本函数只做「当前阶段 + 是否到点」→「下一阶段」的
 * 查表，不碰时钟——时钟比较由服务用时间戳完成。
 */

export type PomodoroPhase = "idle" | "focus" | "break";

export interface PomodoroAdvance {
  /** 迁移后的阶段 */
  phase: PomodoroPhase;
  /** 刚完成的是哪个阶段（驱动通知文案与宠物状态切换；null = 无迁移） */
  completed: "focus" | "break" | null;
}

/**
 * 阶段迁移决策：`timeUp` 由调用方用时间戳比较得出（now >= deadline）。
 * - idle：不管 timeUp 与否都原地不动（idle 没有"到点"概念）；
 * - focus 到点 → break；
 * - break 到点 → idle（**主动承诺才叫专注**——不自动开始下一轮 focus）；
 * - 未到点 → 原地不动。
 */
export function advancePomodoro(phase: PomodoroPhase, timeUp: boolean): PomodoroAdvance {
  if (!timeUp || phase === "idle") return { phase, completed: null };
  if (phase === "focus") return { phase: "break", completed: "focus" };
  return { phase: "idle", completed: "break" };
}
