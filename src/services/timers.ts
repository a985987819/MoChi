/**
 * TimerService —— 站立提醒（StandupService）+ 番茄钟（PomodoroService）。
 * 规格：docs/learning/08-timers-reminders-presence.md §4（本文件即其实现）。
 *
 * # 时间基准三原则（08 §4.1，本文件的地基）
 *
 * 1. **一切截止时间是时间戳**（epoch ms），不是剩余秒数递减——setInterval 累计会漂移；
 * 2. 每秒 tick 只做 `now >= deadline ? fire() : broadcast()`——tick 被节流/丢失不影响
 *    正确性（最坏延迟一个节流周期）；
 * 3. 睡眠/唤醒：唤醒后第一次 tick 用时间戳比较，补发一次（状态迁移幂等）。
 *
 * # 职责与联动
 *
 * - StandupService：armed →(到点且在场)→ fired（alert 弹窗+通知+宠物 alert）→
 *   用户点击弹窗（standup-ack）→ stretch 2s → 重新计时；10 分钟无人点自动收尾；
 *   away 时到点**不弹**（保持 armed，恢复在场即弹——idle≠没在忙，08 §3.2）。
 * - PomodoroService：idle→focus→break→idle（休息结束**不**自动续轮，08 §4.3）；
 *   focus/break 期间宠物 system 槽锁定；每秒广播 pomodoroChanged（Tab 倒计时）。
 * - 单击宠物重置：PetApp emit `ui://reset-standup`（v0.2.0 契约）→ 本文件监听。
 * - 配置热更新：监听 `state://settings-changed`，改站立间隔即重置（08 §4.2）。
 *
 * 驻留宠物窗（常宿主）；chat 窗通过事件遥控番茄钟（state://pomodoro-start/stop）。
 */

import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";
import { UI_EVENTS, STATE_EVENTS } from "@/shared/events";
import { petState } from "@/services/pet-state";
import { presenceService } from "@/services/presence";
import { notify } from "@/services/notifications";
import { loadSettings } from "@/services/settings";

interface TimerConfig {
  standupIntervalMin: number;
  pomodoroFocusMin: number;
  pomodoroBreakMin: number;
  notificationsEnabled: boolean;
}

async function loadConfig(): Promise<TimerConfig> {
  const s = await loadSettings();
  return {
    standupIntervalMin: s.standupIntervalMin,
    pomodoroFocusMin: s.pomodoroFocusMin,
    pomodoroBreakMin: s.pomodoroBreakMin,
    notificationsEnabled: s.notificationsEnabled,
  };
}

// ── 站立提醒 ────────────────────────────────────────────────────────────

/** 弹窗 10 分钟无人点自动收尾（08 §2.3 迟滞表） */
const ALERT_AUTO_DISMISS_MS = 10 * 60_000;

export class StandupService {
  /** armed=计时中；fired=弹窗已显示（等待点击/超时） */
  state: "armed" | "fired" = "armed";
  private deadline = 0;
  private config: TimerConfig = {
    standupIntervalMin: 60,
    pomodoroFocusMin: 25,
    pomodoroBreakMin: 5,
    notificationsEnabled: true,
  };
  private autoDismiss: number | null = null;

  async start(): Promise<void> {
    this.config = await loadConfig();
    this.rearm();

    // 单击宠物重置（v0.2.0 契约事件的正式消费方）
    await listen(UI_EVENTS.resetStandup, () => this.rearm("reset"));
    // 用户点击提醒弹窗（alert 页 emit；Rust 同时隐藏弹窗）
    await listen(UI_EVENTS.standupAck, () => void this.ack());
    // 暂停提醒（v0.9.0：托盘菜单「暂停 1 小时」/ 提醒弹窗「稍后 5 分钟」共用，
    // P1-11 的弹窗按钮走同一入口）
    await listen<{ minutes?: unknown }>(STATE_EVENTS.standupSnooze, e => {
      const minutes = typeof e.payload?.minutes === "number" ? e.payload.minutes : 5;
      this.snooze(minutes);
    });
    // 配置热更新：先重载配置，再按变更键决定是否重置——
    // P0-02：改通知开关不该把已经走了 40 分钟的站立计时清零
    await listen<{ keys?: string[] }>(STATE_EVENTS.settingsChanged, e => {
      const keys = e.payload?.keys ?? [];
      void this.reloadConfig(keys);
    });
    // 在场变化：away→active 时若已到点，下一 tick 立即补弹

    window.setInterval(() => this.tick(), 1000);
  }

  /**
   * 配置重载 + 条件重置（P0-02）。
   * 先 loadConfig 再判断 rearm：顺序不能反——反了会用旧间隔重置（竞态）。
   * keys 为空视为"旧版广播"（未携带变更键），保持旧行为直接重置。
   */
  private async reloadConfig(keys: string[] = []): Promise<void> {
    this.config = await loadConfig();
    if (keys.length === 0 || keys.includes("standupIntervalMin")) this.rearm("config");
  }

  /** 距下次提醒的秒数（右键菜单「还剩 N 分钟」展示用；fired 态返回 0） */
  remainingSec(): number {
    if (this.state !== "armed") return 0;
    return Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
  }

  /**
   * 暂停提醒：把截止时间推到 now + minutes，不改配置里的常规间隔。
   * 与 rearm 的差别：rearm 用配置间隔（单击宠物=重新开始本轮），snooze 是
   * "我知道了但想多坐会儿"——语义不同，入口不同（右键菜单/弹窗稍后按钮）。
   */
  snooze(minutes: number): void {
    if (this.autoDismiss != null) {
      window.clearTimeout(this.autoDismiss);
      this.autoDismiss = null;
    }
    if (petState.current === "alert") petState.clearSystem(); // alert 态暂停 = 同时收掉弹窗
    this.state = "armed";
    this.deadline = Date.now() + minutes * 60_000;
  }

  /** 重新计时（单击/点击弹窗/改配置共用出口） */
  private rearm(_reason?: string): void {
    this.state = "armed";
    this.deadline = Date.now() + this.config.standupIntervalMin * 60_000;
    if (this.autoDismiss != null) window.clearTimeout(this.autoDismiss);
    this.autoDismiss = null;
    // 保险：异常残留的 alert 系统状态清掉（正常路径 ack 已清）
    if (petState.current === "alert") petState.clearSystem();
  }

  private tick(): void {
    if (this.state !== "armed") return;
    if (Date.now() < this.deadline) return;
    // away 时到点：保持 armed（deadline 已过去），恢复在场后立即补弹
    if (presenceService.current === "away") return;
    void this.fire();
  }

  private async fire(): Promise<void> {
    this.state = "fired";
    petState.setSystem("alert"); // 粘性：ack 才释放（优先级最高，08 §2.2）
    if (this.config.notificationsEnabled) {
      void notify("该站起来啦 🧍", `麻薯陪你坐了 ${this.config.standupIntervalMin} 分钟，点击提醒重置计时`);
    }
    void emit(UI_EVENTS.showAlert); // Rust：定位到宠物正上方并 show
    this.autoDismiss = window.setTimeout(() => void this.ack(), ALERT_AUTO_DISMISS_MS);
  }

  /** 点击弹窗 / 超时收尾：播放 stretch → 重新计时 */
  private async ack(): Promise<void> {
    if (this.state !== "fired") return;
    this.state = "armed";
    if (this.autoDismiss != null) window.clearTimeout(this.autoDismiss);
    this.autoDismiss = null;
    petState.clearSystem();
    petState.setSystem("stretch", 2); // 奖励动画 2s 后自然回落 idle
    this.deadline = Date.now() + this.config.standupIntervalMin * 60_000;
  }
}

// ── 番茄钟 ──────────────────────────────────────────────────────────────

export type PomodoroPhase = "idle" | "focus" | "break";

export interface PomodoroStatus {
  phase: PomodoroPhase;
  remainingSec: number;
}

export class PomodoroService {
  phase: PomodoroPhase = "idle";
  private deadline = 0;
  private config: TimerConfig = {
    standupIntervalMin: 60,
    pomodoroFocusMin: 25,
    pomodoroBreakMin: 5,
    notificationsEnabled: true,
  };

  async start(): Promise<void> {
    this.config = await loadConfig();
    await listen(STATE_EVENTS.settingsChanged, () => {
      // 番茄钟进行中不受配置热更新影响（时间基准已在跑）；下一轮 start 生效
      void loadConfig().then(c => (this.config = c));
    });
    // chat 窗遥控（Agent 工具 / PomodoroTab）
    await listen<{ minutes?: unknown }>(STATE_EVENTS.pomodoroStart, e => {
      const min = typeof e.payload?.minutes === "number" ? e.payload.minutes : undefined;
      this.startFocus(min);
    });
    await listen(STATE_EVENTS.pomodoroStop, () => this.stop());

    window.setInterval(() => this.tick(), 1000);
  }

  /** 启动专注（ minutes 已由工具/UI 校验范围） */
  startFocus(minutes?: number): void {
    if (this.phase === "focus") return; // 已在专注中：忽略重复启动（工具返回 ok:false 由调用方判断）
    const min = minutes ?? this.config.pomodoroFocusMin;
    this.phase = "focus";
    this.deadline = Date.now() + min * 60_000;
    petState.setSystem("focus"); // 粘性：阶段结束/stop 释放
    this.broadcast();
  }

  stop(): void {
    if (this.phase === "idle") return;
    this.phase = "idle";
    petState.clearSystem();
    this.broadcast();
  }

  status(): PomodoroStatus {
    const remainingSec =
      this.phase === "idle" ? 0 : Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
    return { phase: this.phase, remainingSec };
  }

  private tick(): void {
    if (this.phase === "idle" || Date.now() < this.deadline) {
      if (this.phase !== "idle") this.broadcast(); // 倒计时刷新
      return;
    }
    // 时间戳比较触发阶段迁移（睡眠唤醒后同样正确，08 §4.1 原则 3）
    if (this.phase === "focus") {
      this.phase = "break";
      this.deadline = Date.now() + this.config.pomodoroBreakMin * 60_000;
      petState.setSystem("break");
      if (this.config.notificationsEnabled) void notify("专注完成 🍅", `休息 ${this.config.pomodoroBreakMin} 分钟，麻薯等你回来`);
    } else {
      // break → idle：休息结束不自动续轮（主动承诺才叫专注，08 §4.3）
      this.phase = "idle";
      petState.clearSystem();
      if (this.config.notificationsEnabled) void notify("休息结束 ☕", "准备好就开始下一轮番茄钟吧");
    }
    this.broadcast();
  }

  private broadcast(): void {
    void emit(STATE_EVENTS.pomodoroChanged, this.status());
  }
}

/** 宠物窗单例（pet/main.tsx start） */
export const standupService = new StandupService();
export const pomodoroService = new PomodoroService();
