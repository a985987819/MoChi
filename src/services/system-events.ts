/**
 * 系统事件（v0.11.0）—— 休眠恢复与锁屏。
 *
 * # 为什么这不是"锦上添花"
 *
 * 合盖睡一晚再打开，是这个应用最容易被骂的场景：
 * 1. 站立提醒、自定义提醒全部积压，醒来**一次补发一串**弹窗；
 * 2. 宠物在锁屏期间仍可能把提醒弹到锁屏界面上（用户根本看不见）。
 *
 * # 信号从哪来
 *
 * Rust 的原生节拍（1s）是唯一可靠的时间源：线程 `sleep` 在休眠期间被冻结，
 * 醒来后第一拍的 `elapsed()` 就是"实际睡了多久"——JS 的 `setInterval` 做不到这件事
 * （休眠时根本不执行，醒来也不会知道自己少跑了多少拍）。
 *
 * 节拍载荷 `{ gap_ms, locked }`：
 * - `gap_ms >= 5s` → 认为刚从休眠/长卡顿恢复（阈值远大于 1s，正常抖动不会触发）；
 * - `gap_ms >= 5min` → 标记 `burst`（大概率错过了整段提醒，需要合并交付）；
 * - `locked` 变化 → 广播锁屏状态（判据见 lib.rs `session_locked`，只问"有没有前台窗口"）。
 *
 * 本文件只做"翻译与广播"，不直接改其他服务的状态：presence / reminders 各自订阅，
 * 保持服务之间的单向依赖（schemas 见 docs/learning/07）。
 */

import { listen } from "@tauri-apps/api/event";
import { sendStateEvent, STATE_EVENTS } from "@/shared/events";

/** 超过这个间隔就认为"系统刚恢复"：1s 节拍的正常抖动远小于它 */
export const RESUME_GAP_MS = 5_000;
/** 超过这个间隔认为错过了整段时间：恢复时提醒需要合并，不再逐条补发 */
export const BURST_GAP_MS = 5 * 60_000;

/** 节拍间隔 → 事件类型（纯函数，可单测） */
export type TickGapKind = "resume" | "burst" | null;

/**
 * 判定一次节拍间隔意味着什么。
 * null = 正常节拍（什么都不做）——大多数调用都该走这条路，别在正常路径上做额外工作。
 */
export function classifyTickGap(gapMs: number): TickGapKind {
  if (!Number.isFinite(gapMs) || gapMs < RESUME_GAP_MS) return null;
  return gapMs >= BURST_GAP_MS ? "burst" : "resume";
}

/**
 * 合并提醒的正文：最多列 5 条，其余用"等 N 条"收尾（纯函数，可单测）。
 *
 * 为什么不逐条列：这是"睡醒后一次性交付"，正文过长会撑爆提醒弹窗（320×200）。
 */
export function formatBatchBody(texts: readonly string[], limit = 5): string {
  const clean = texts.map(text => text.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  const shown = clean.slice(0, limit);
  const rest = clean.length - shown.length;
  return rest > 0 ? `${shown.join("；")}；等 ${rest} 条` : shown.join("；");
}

/** 节拍载荷（与 lib.rs `start_native_tick` 的 json! 一一对应） */
interface TickPayload {
  gap_ms?: unknown;
  locked?: unknown;
}

/**
 * 启动系统事件翻译器。返回释放函数（宿主监督器/热更新用）。
 *
 * 只应在宠物窗调用一次：它是应用生命周期最长的窗口（关闭=隐藏、进程常驻）。
 */
export function startSystemEvents(): Promise<() => void> {
  let lastLocked: boolean | null = null;
  let disposed = false;

  return listen<TickPayload>(STATE_EVENTS.nativeTick, event => {
    if (disposed) return;
    const gapMs = typeof event.payload?.gap_ms === "number" ? event.payload.gap_ms : 0;
    const kind = classifyTickGap(gapMs);
    if (kind) {
      // 恢复事件先发：presence 会立刻重算在场，提醒调度据此决定是否合并
      void sendStateEvent(STATE_EVENTS.systemResumed, { gapMs, burst: kind === "burst" }).catch(() => undefined);
    }

    const locked = event.payload?.locked === true;
    if (locked !== lastLocked) {
      lastLocked = locked;
      void sendStateEvent(STATE_EVENTS.sessionLockChanged, { locked }).catch(() => undefined);
    }
  }).then(off => () => {
    disposed = true;
    off();
  });
}
