/**
 * PetStateManager —— 宠物状态的**唯一仲裁者**。
 *
 * 设计规格：docs/learning/08-timers-reminders-presence.md §2；素材约定：docs/pet-assets.md §3。
 *
 * # 槽位模型（三层来源，各管各的）
 *
 *   systemSlot（alert/focus/break/sleep/stretch…）  系统事件：计时器/在场服务等，粘性由所有者管理
 *   presenceSlot（sleep）                           在场检测：v0.7.0 接入，槽位先就位
 *   moodSlot（happy/sad…）                          Agent 情绪：默认 6~10s 随机寿命，防"卡表情"
 *
 * # 仲裁
 *
 *   active = system ?? presence ?? mood ?? idle
 *
 * 任何槽位变化 → recompute() → 与当前 active 不同则广播 `state://pet-changed`。
 * 系统状态期间情绪**不抢占**（07 边界文档："Agent 提议，应用裁决"）；
 * 槽位过期自动清空并回落（迟滞防抖见 08 §2.3）。
 *
 * # 与渲染的关系
 *
 * 本类**只管状态仲裁，不管图片**（素材解析见 pet-assets.ts）；
 * 渲染层（PetApp）订阅 petChanged 事件自行取图。单例导出，宠物窗内直接用；
 * 其他窗口通过 `state://set-*` 事件遥控（installRemoteListeners）。
 */

import { listen, emit } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";

/** v1 状态全集（素材文件名与之一致，见 docs/pet-assets.md §3） */
export const PET_STATES = [
  "idle", "happy", "sad", "thinking", "talking",
  "alert", "stretch", "focus", "break", "sleep",
] as const;
export type PetState = (typeof PET_STATES)[number];

export function isPetState(v: unknown): v is PetState {
  return typeof v === "string" && (PET_STATES as readonly string[]).includes(v);
}

interface SlotEntry {
  state: PetState;
  /** 过期时刻（epoch ms）；null = 粘性，由所有者显式清除（如番茄钟 stop） */
  expiresAt: number | null;
}

/** 三个状态槽的名字（仲裁优先级独立于这里的顺序，见 recompute） */
type SlotName = "system" | "presence" | "mood";

/** 情绪状态默认寿命区间（ms）：机械固定值会显得像机器人，故意随机 */
const MOOD_DURATION_MIN = 6000;
const MOOD_DURATION_MAX = 10000;

export class PetStateManager {
  private system: SlotEntry | null = null;
  private presence: SlotEntry | null = null; // v0.7.0 PresenceService 驱动
  private mood: SlotEntry | null = null;
  private active: PetState = "idle";
  private listeners = new Set<(state: PetState) => void>();
  private expiryTimers = new Map<SlotName, number>();

  /** 订阅仲裁结果变化（渲染层用）。返回取消函数 */
  subscribe(fn: (state: PetState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 当前生效状态（同步读取） */
  get current(): PetState {
    return this.active;
  }

  /** 情绪槽：Agent/演示菜单入口。durationSec 缺省 6~10s 随机 */
  setMood(state: PetState, durationSec?: number): void {
    const ms = durationSec != null ? durationSec * 1000 : this.randomMoodDuration();
    this.setSlot("mood", state, Date.now() + ms);
  }

  /** 系统槽：计时器/演示菜单入口。durationSec 缺省 = 粘性（由服务显式清除） */
  setSystem(state: PetState, durationSec?: number): void {
    this.setSlot("system", state, durationSec != null ? Date.now() + durationSec * 1000 : null);
  }

  /** 在场槽（v0.7.0 前无驱动者，接口先立） */
  setPresence(state: PetState, durationSec?: number): void {
    this.setSlot("presence", state, durationSec != null ? Date.now() + durationSec * 1000 : null);
  }

  clearSystem(): void {
    this.setSlot("system", "idle", null);
    this.system = null;
    this.recompute();
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private setSlot(slot: SlotName, state: PetState, expiresAt: number | null): void {
    this[slot] = state === "idle" ? null : { state, expiresAt };
    const old = this.expiryTimers.get(slot);
    if (old != null) window.clearTimeout(old);
    this.expiryTimers.delete(slot);
    if (expiresAt != null) {
      const delay = Math.max(0, expiresAt - Date.now());
      this.expiryTimers.set(slot, window.setTimeout(() => {
        this[slot] = null;      // 到期清槽 → 回落（08：超时回落防卡表情）
        this.recompute();
      }, delay));
    }
    this.recompute();
  }

  private recompute(): void {
    // 先清理所有已过期但定时器尚未触发的槽（防御性：时钟回拨等边界）
    const now = Date.now();
    for (const slot of ["system", "presence", "mood"] as const) {
      const entry = this[slot];
      if (entry?.expiresAt != null && entry.expiresAt <= now) this[slot] = null;
    }
    const next: PetState = this.system?.state ?? this.presence?.state ?? this.mood?.state ?? "idle";
    if (next === this.active) return;
    this.active = next;
    // ① 本窗口监听者即时回调；② 跨窗口广播（聊天窗 v0.4.0 起订阅做状态联动）
    for (const fn of this.listeners) fn(next);
    void emit(STATE_EVENTS.petChanged, { state: next });
  }

  private randomMoodDuration(): number {
    return MOOD_DURATION_MIN + Math.random() * (MOOD_DURATION_MAX - MOOD_DURATION_MIN);
  }

  /**
   * 安装跨窗口遥控监听（在宠物窗 main.tsx 调用一次）。
   * 载荷校验失败静默忽略——广播事件没有编译期保障，收方必须自查（08 §2.2 教训）。
   */
  async installRemoteListeners(): Promise<void> {
    await listen<{ state?: unknown; durationSec?: unknown }>(STATE_EVENTS.setMood, (e) => {
      if (isPetState(e.payload?.state)) {
        this.setMood(e.payload.state, typeof e.payload.durationSec === "number" ? e.payload.durationSec : undefined);
      }
    });
    await listen<{ state?: unknown; durationSec?: unknown }>(STATE_EVENTS.setSystem, (e) => {
      if (isPetState(e.payload?.state)) {
        this.setSystem(e.payload.state, typeof e.payload.durationSec === "number" ? e.payload.durationSec : undefined);
      }
    });
    await listen(STATE_EVENTS.clearSystem, () => this.clearSystem());
  }
}

/** 宠物窗内使用的单例（其他窗口不 import 本类，走事件遥控） */
export const petState = new PetStateManager();
