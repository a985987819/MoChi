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
import { emit, listen } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";
import { petState } from "@/services/pet-state";
import { subscribeHeartbeat } from "@/services/heartbeat";

export type Presence = "active" | "away";

const POLL_MS = 10_000;
const AWAY_AFTER_SEC = 300; // 迟滞：进入 away 阈值；退出阈值为 0（任意输入）

export class PresenceService {
  private presence: Presence = "active";
  private cleanup: Array<() => void> = [];
  private running = false;
  private generation = 0;
  private polling = false;
  private nextPoll = 0;
  private activeSince = Date.now();
  private returnedAt: number | null = null;
  private lastObservedAt: number | null = null;
  /** 立即重算的入口（start 里赋值的闭包）；锁屏解锁/休眠恢复用它跳过 10s 节流 */
  private wake: (() => void) | null = null;

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
    this.wake = check;
    check();
    void subscribeHeartbeat(check).then(off => {
      if (!this.running || generation !== this.generation) off();
      else this.cleanup.push(off);
    });
    // 系统事件（v0.11.0）：锁屏立刻按离开处理；休眠恢复立刻重算活动段。
    // 监听放在这里而不是页面里——presence 是这两个状态的唯一所有者。
    void listen<{ locked: boolean }>(STATE_EVENTS.sessionLockChanged, event => {
      if (!this.running || generation !== this.generation) return;
      this.handleSessionLock(event.payload?.locked === true);
    }).then(off => {
      if (!this.running || generation !== this.generation) off();
      else this.cleanup.push(off);
    }).catch(() => undefined);
    void listen(STATE_EVENTS.systemResumed, () => {
      if (!this.running || generation !== this.generation) return;
      this.handleResume();
    }).then(off => {
      if (!this.running || generation !== this.generation) off();
      else this.cleanup.push(off);
    }).catch(() => undefined);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.wake = null;
    for (const off of this.cleanup.splice(0)) off();
  }

  /**
   * 锁屏（v0.11.0）：立刻判为离开，不等 5 分钟空闲阈值——
   * 否则锁屏后的头 5 分钟仍可能把提醒弹到锁屏界面上（用户看不见）。
   * 解锁后的首次轮询会按真实空闲秒数自愈回 active。
   */
  handleSessionLock(locked: boolean): void {
    if (!this.running) return;
    if (locked) {
      this.applyPresence("away");
      return;
    }
    this.nextPoll = 0;
    this.wake?.();
  }

  /**
   * 休眠恢复（v0.11.0）：活动段从零开始算（睡眠不该算作连续陪伴），并立刻重算一次。
   * 不这么做的话，`activeMinutes` 会把整晚睡眠算进去，点击文案会说出荒谬的陪伴时长。
   */
  handleResume(): void {
    if (!this.running) return;
    this.lastObservedAt = null;
    this.activeSince = Date.now();
    this.nextPoll = 0;
    this.wake?.();
  }

  /** 在场状态迁移的唯一出口：宠物状态、订阅者、跨窗口广播三处必须同步 */
  private applyPresence(next: Presence): void {
    if (next === this.presence) return;
    const now = Date.now();
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
    this.applyPresence(next);
  }
}

/** 宠物窗单例 */
export const presenceService = new PresenceService();
