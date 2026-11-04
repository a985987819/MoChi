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
import type { PomodoroResult } from "@/services/pomodoro-control";

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

/** 站立计时与弹窗收尾汇入同一状态机，在场判断只推迟触发，不暂停计时。 */
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
    // 配置热更新：改间隔即重置（08 §4.2）
    await listen(STATE_EVENTS.settingsChanged, () => void this.reloadConfig());
    // 在场变化：away→active 时若已到点，下一 tick 立即补弹

    window.setInterval(() => this.tick(), 1000);
  }

  /** 重载全部配置，但只有站立间隔改变才重置计时。 */
  private async reloadConfig(): Promise<void> {
    const next = await loadConfig();
    const intervalChanged = next.standupIntervalMin !== this.config.standupIntervalMin;
    this.config = next;
    // 保存 Key、切通知开关等也会广播设置变化，不能因此不断推迟站立提醒。
    if (intervalChanged) this.rearm("config");
  }

  /** 重新计时（单击/点击弹窗/改配置共用出口） */
  private rearm(_reason?: string): void {
    if (this.state === "fired") void emit(UI_EVENTS.hideAlert);
    this.state = "armed";
    this.deadline = Date.now() + this.config.standupIntervalMin * 60_000;
    if (this.autoDismiss != null) window.clearTimeout(this.autoDismiss);
    this.autoDismiss = null;
    // 保险：异常残留的 alert 系统状态清掉（正常路径 ack 已清）
    petState.clearSystem("standup");
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
    petState.setSystem("alert", undefined, "standup"); // 粘性：ack 才释放
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
    // 超时与单击宠物也要隐藏原生窗口，不能只更新 TS 状态。
    void emit(UI_EVENTS.hideAlert);
    petState.setSystem("stretch", 2, "standup"); // 结束后恢复其他服务仍持有的状态
    this.deadline = Date.now() + this.config.standupIntervalMin * 60_000;
  }
}

// ── 番茄钟 ──────────────────────────────────────────────────────────────

export type PomodoroPhase = "idle" | "focus" | "break";

export interface PomodoroStatus {
  phase: PomodoroPhase;
  remainingSec: number;
  /** 空闲界面展示配置值，而不是硬编码 25:00。 */
  focusMin: number;
}

/** 宠物窗是唯一计时宿主；UI 与工具通过回执共享执行结果。 */
export class PomodoroService {
  phase: PomodoroPhase = "idle";
  private deadline = 0;
  private activeBreakMin = 5;
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
      void loadConfig().then(c => { this.config = c; this.broadcast(); });
    });
    // chat 窗遥控（Agent 工具 / PomodoroTab）
    await listen<{ minutes?: unknown; requestId?: string }>(STATE_EVENTS.pomodoroStart, e => {
      const min = e.payload?.minutes;
      const result = min != null && typeof min !== "number"
        ? { ok: false as const, error: "专注时长必须是数字" }
        : this.startFocus(min ?? undefined);
      this.reply(e.payload?.requestId, result);
    });
    await listen<{ requestId?: string }>(STATE_EVENTS.pomodoroStop, e => {
      this.stop();
      this.reply(e.payload?.requestId, { ok: true, data: this.status() });
    });
    await listen<{ requestId?: string }>(STATE_EVENTS.pomodoroQuery, e => {
      this.reply(e.payload?.requestId, { ok: true, data: this.status() });
    });

    window.setInterval(() => this.tick(), 1000);
  }

  /** 服务是最终执行边界，跨窗口广播也必须校验，不能仅信任工具层。 */
  startFocus(minutes?: number): PomodoroResult {
    if (this.phase === "focus") return { ok: false, error: "已有番茄钟在专注中，请先停止或等它结束" };
    const min = minutes ?? this.config.pomodoroFocusMin;
    if (!Number.isFinite(min) || min < 5 || min > 90) {
      return { ok: false, error: "专注时长需在 5~90 分钟之间" };
    }
    this.phase = "focus";
    this.deadline = Date.now() + min * 60_000;
    this.activeBreakMin = this.config.pomodoroBreakMin; // 本轮休息时长也在启动时固定
    petState.setSystem("focus", undefined, "pomodoro"); // 粘性：阶段结束/stop 释放
    this.broadcast();
    return { ok: true, data: this.status() };
  }

  stop(): void {
    if (this.phase === "idle") return;
    this.phase = "idle";
    petState.clearSystem("pomodoro");
    this.broadcast();
  }

  status(): PomodoroStatus {
    const remainingSec =
      this.phase === "idle" ? 0 : Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
    return { phase: this.phase, remainingSec, focusMin: this.config.pomodoroFocusMin };
  }

  private tick(): void {
    if (this.phase === "idle" || Date.now() < this.deadline) {
      if (this.phase !== "idle") this.broadcast(); // 倒计时刷新
      return;
    }
    // 时间戳比较触发阶段迁移（睡眠唤醒后同样正确，08 §4.1 原则 3）
    if (this.phase === "focus") {
      this.phase = "break";
      this.deadline = Date.now() + this.activeBreakMin * 60_000;
      petState.setSystem("break", undefined, "pomodoro");
      if (this.config.notificationsEnabled) void notify("专注完成 🍅", `休息 ${this.activeBreakMin} 分钟，麻薯等你回来`);
    } else {
      // break → idle：休息结束不自动续轮（主动承诺才叫专注，08 §4.3）
      this.phase = "idle";
      petState.clearSystem("pomodoro");
      if (this.config.notificationsEnabled) void notify("休息结束 ☕", "准备好就开始下一轮番茄钟吧");
    }
    this.broadcast();
  }

  private broadcast(): void {
    void emit(STATE_EVENTS.pomodoroChanged, this.status());
  }

  /** 回执在状态迁移后发送；重复启动的判定由这个唯一宿主原子完成。 */
  private reply(requestId: string | undefined, result: PomodoroResult): void {
    if (typeof requestId === "string") void emit(STATE_EVENTS.pomodoroResult, { requestId, result });
  }
}

/** 宠物窗单例（pet/main.tsx start） */
export const standupService = new StandupService();
export const pomodoroService = new PomodoroService();
