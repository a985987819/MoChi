/**
 * PresenceService —— 在场检测（learning/08 §3）。
 *
 * 只读 OS 的"距上次输入秒数"（Rust get_idle_seconds，聚合数字、零内容访问），
 * 带迟滞地维护 active/away 两态：
 * - 进入 away：无输入 ≥ 5 分钟；退出：任意输入**立即**（阈值不对称防抖动）；
 * - away 驱动宠物 `sleep` 状态（presence 槽，learning/08 §2.2 优先级）；
 * - away 期间到点的站立提醒/自定义提醒**推迟**而非取消（08：idle≠没在忙，
 *   计时不暂停，只推迟弹窗——读纸质书的用户恰恰最需要提醒）。
 *
 * 驻留宠物窗（常驻宿主）；每 10s 轮询一个 u64，成本可忽略。
 */

import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";
import { petState } from "@/services/pet-state";

export type Presence = "active" | "away";

const POLL_MS = 10_000;
const AWAY_AFTER_SEC = 300; // 迟滞：进入 away 阈值；退出阈值为 0（任意输入）

export class PresenceService {
  private presence: Presence = "active";
  private timer: number | null = null;

  get current(): Presence {
    return this.presence;
  }

  subscribe(fn: (p: Presence) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private listeners = new Set<(p: Presence) => void>();

  start(): void {
    if (this.timer != null) return;
    void this.poll();
    this.timer = window.setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    // 失败按 0 秒处理 = 用户在场（宁误"在场"向，不打扰）
    const idleSec = await invoke<number>("get_idle_seconds").catch(() => 0);
    const next: Presence = idleSec >= AWAY_AFTER_SEC ? "away" : "active";
    if (next === this.presence) return;

    this.presence = next;
    if (next === "away") {
      petState.setPresence("sleep"); // presence 槽（sticky），恢复由本服务清
    } else {
      petState.clearPresence();
    }
    for (const fn of this.listeners) fn(next);
    void emit(STATE_EVENTS.presenceChanged, { presence: next });
  }
}

/** 宠物窗单例 */
export const presenceService = new PresenceService();
