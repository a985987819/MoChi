/**
 * PetStateManager —— 宠物状态的**唯一仲裁者**。
 *
 * 设计规格：docs/learning/08-timers-reminders-presence.md §2；素材约定：docs/pet-assets.md §3。
 *
 * # 槽位模型（三层来源，各管各的）
 *
 *   systemSlots（按服务分槽）                     系统事件：各服务只释放自己的状态
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

/** 跨窗口载荷没有编译期保障，先用白名单缩窄后才能进入状态机。 */
export function isPetState(v: unknown): v is PetState {
  return typeof v === "string" && (PET_STATES as readonly string[]).includes(v);
}

interface SlotEntry {
  state: PetState;
  /** 过期时刻（epoch ms）；null = 粘性，由所有者显式清除（如番茄钟 stop） */
  expiresAt: number | null;
}

/** 非系统来源各保留一个槽；系统来源使用按 owner 分组的 Map。 */
type SlotName = "presence" | "mood";

/** 情绪状态默认寿命区间（ms）：机械固定值会显得像机器人，故意随机 */
const MOOD_DURATION_MIN = 6000;
const MOOD_DURATION_MAX = 10000;

/** 服务各自持有系统状态，展示层只订阅仲裁结果，避免跨服务清理互相干扰。 */
export class PetStateManager {
  private systems = new Map<string, SlotEntry>();
  private systemTimers = new Map<string, number>();
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

  /** 原生心跳按绝对时间清过期槽，隐藏时 JS timeout 被节流也不会卡住临时表情。 */
  refresh(): void { this.recompute(); }

  /** 情绪槽：Agent/演示菜单入口。durationSec 缺省 6~10s 随机 */
  setMood(state: PetState, durationSec?: number): void {
    const ms = durationSec != null ? durationSec * 1000 : this.randomMoodDuration();
    this.setSlot("mood", state, Date.now() + ms);
  }

  /**
   * 系统状态按 owner 保存，避免提醒结束时把仍在运行的番茄钟一起清掉。
   * 同一服务可替换自己的状态；不同服务按 alert > stretch > focus/break 仲裁。
   */
  setSystem(state: PetState, durationSec?: number, owner = "default"): void {
    this.clearSystemTimer(owner);
    this.systems.delete(owner); // 更新时移到 Map 尾部，同优先级以最新提议为准
    if (state !== "idle") this.systems.set(owner, {
      state, expiresAt: durationSec != null ? Date.now() + durationSec * 1000 : null,
    });
    if (state !== "idle" && durationSec != null) {
      this.systemTimers.set(owner, window.setTimeout(() => this.clearSystem(owner), durationSec * 1000));
    }
    this.recompute();
  }

  /** 在场槽（v0.7.0 PresenceService 驱动：away→sleep 粘性） */
  setPresence(state: PetState, durationSec?: number): void {
    this.setSlot("presence", state, durationSec != null ? Date.now() + durationSec * 1000 : null);
  }

  /** 清除在场槽（用户恢复活动，PresenceService 调用） */
  clearPresence(): void {
    this.presence = null;
    const old = this.expiryTimers.get("presence");
    if (old != null) window.clearTimeout(old);
    this.expiryTimers.delete("presence");
    this.recompute();
  }

  /** 只释放调用者拥有的状态；其余服务的粘性状态会重新显现。 */
  clearSystem(owner = "default"): void {
    this.clearSystemTimer(owner);
    this.systems.delete(owner);
    this.recompute();
  }

  private clearSystemTimer(owner: string): void {
    const timer = this.systemTimers.get(owner);
    if (timer != null) window.clearTimeout(timer);
    this.systemTimers.delete(owner);
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
    for (const [owner, entry] of this.systems) {
      if (entry.expiresAt != null && entry.expiresAt <= now) {
        this.systems.delete(owner);
        this.clearSystemTimer(owner);
      }
    }
    for (const slot of ["presence", "mood"] as const) {
      const entry = this[slot];
      if (entry?.expiresAt != null && entry.expiresAt <= now) this[slot] = null;
    }
    // 系统内部也有优先级：到点提醒覆盖专注形象，结束后恢复专注。
    const priority = (state: PetState) => state === "alert" ? 3 : state === "stretch" ? 2 : 1;
    const system = [...this.systems.values()].reverse().sort((a, b) => priority(b.state) - priority(a.state))[0];
    const next: PetState = system?.state ?? this.presence?.state ?? this.mood?.state ?? "idle";
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
