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
import { subscribeHeartbeat } from "@/services/heartbeat";

export type Presence = "active" | "away";

const POLL_MS = 10_000;
const AWAY_AFTER_SEC = 300; // 迟滞：进入 away 阈值；退出阈值为 0（任意输入）

export class PresenceService {
  private presence: Presence = "active";
  private cleanup: (() => void) | null = null;
  private running = false;
  private generation = 0;
  private polling = false;
  private nextPoll = 0;
  private activeSince = Date.now();
  private returnedAt: number | null = null;
  private lastObservedAt: number | null = null;

  get current(): Presence {
    return this.presence;
  }

  /** 仅估计当前活动段，不代表工作强度/坐姿；供点击文案选择，不参与提醒计时。 */
  activitySnapshot(now = Date.now()): { activeMinutes: number; recentlyReturned: boolean } {
    const observationStale = this.lastObservedAt != null && now - this.lastObservedAt >= AWAY_AFTER_SEC * 1000;
    return {
      activeMinutes: this.presence === "away" || observationStale ? 0 : Math.max(0, (now - this.activeSince) / 60_000),
      recentlyReturned: observationStale || (this.returnedAt != null && now >= this.returnedAt && now - this.returnedAt < 60_000),
    };
  }

  subscribe(fn: (p: Presence) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private listeners = new Set<(p: Presence) => void>();

  start(): void {
    if (this.running) return;
    this.running = true;
    this.activeSince = Date.now();
    this.returnedAt = null;
    this.lastObservedAt = null;
    const generation = ++this.generation;
    this.nextPoll = 0;
    const check = () => {
      if (!this.running || generation !== this.generation || this.polling || Date.now() < this.nextPoll) return;
      this.nextPoll = Date.now() + POLL_MS;
      this.polling = true;
      void this.poll(generation).finally(() => { this.polling = false; });
    };
    check();
    void subscribeHeartbeat(check).then(off => {
      if (!this.running || generation !== this.generation) off();
      else this.cleanup = off;
    });
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.cleanup?.();
    this.cleanup = null;
  }

  private async poll(generation: number): Promise<void> {
    // 失败按 0 秒处理 = 用户在场（宁误"在场"向，不打扰）
    const idleSec = await invoke<number>("get_idle_seconds").catch(() => 0);
    if (!this.running || generation !== this.generation) return;
    const now = Date.now();
    // 挂起/长时间没有观测后不能把睡眠时间也算作持续活动。
    if (this.lastObservedAt != null && now - this.lastObservedAt >= AWAY_AFTER_SEC * 1000) {
      this.activeSince = now;
      if (idleSec < AWAY_AFTER_SEC) this.returnedAt = now;
    }
    this.lastObservedAt = now;
    const next: Presence = idleSec >= AWAY_AFTER_SEC ? "away" : "active";
    if (next === this.presence) return;

    this.presence = next;
    if (next === "away") {
      petState.setPresence("sleep"); // presence 槽（sticky），恢复由本服务清
    } else {
      this.activeSince = now;
      this.returnedAt = now;
      petState.clearPresence();
    }
    for (const fn of this.listeners) fn(next);
    void emit(STATE_EVENTS.presenceChanged, { presence: next }).catch(() => undefined);
  }
}

/** 宠物窗单例 */
export const presenceService = new PresenceService();
