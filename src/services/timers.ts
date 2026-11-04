/**
 * TimerService：时间戳是权威，原生节拍唤醒检查、JS interval 作为后备。
 * 站立/番茄钟各自持有宠物状态和带 id 的可见提醒；系统通知只是附加通道。
 * 设计与复盘：docs/learning/08-timers-reminders-presence.md §4。
 */
import { listen, emit } from "@tauri-apps/api/event";
import { UI_EVENTS, STATE_EVENTS } from "@/shared/events";
import { petState } from "@/services/pet-state";
import { presenceService } from "@/services/presence";
import { notify } from "@/services/notifications";
import { loadSettings } from "@/services/settings";
import { showAppAlert, dismissAppAlert, type AppAlert } from "@/services/alerts";
import { subscribeHeartbeat } from "@/services/heartbeat";
import { ServiceScope } from "@/services/service-scope";
import type { PomodoroResult } from "@/services/pomodoro-control";

type TimerConfig = Pick<Awaited<ReturnType<typeof loadSettings>>,
  "standupIntervalMin" | "pomodoroFocusMin" | "pomodoroBreakMin" | "notificationsEnabled">;
const defaults = (): TimerConfig => ({ standupIntervalMin: 60, pomodoroFocusMin: 25, pomodoroBreakMin: 5, notificationsEnabled: true });
const ALERT_AUTO_DISMISS_MS = 10 * 60_000;

/** 站立计时不会因 away 暂停；弹窗失败保留已过期的 deadline，下一节拍重试。 */
export class StandupService {
  state: "armed" | "fired" = "armed";
  private deadline = 0;
  private config = defaults();
  private dismissAt = 0;
  private alertId: string | null = null;
  private starting: Promise<void> | null = null;
  private scope: ServiceScope | null = null;
  private deliveryInFlight = false;
  private pendingDismiss = new Set<string>();
  private dismissing = new Set<string>();

  /** 多次调用共用初始化；失败释放资源，允许宿主监督器稍后重试。 */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    const scope = new ServiceScope();
    this.scope = scope;
    this.starting = this.initialize(scope).catch(error => {
      scope.dispose();
      if (this.scope === scope) this.starting = null;
      throw error;
    });
    return this.starting;
  }

  private async initialize(scope: ServiceScope): Promise<void> {
    const config = await loadSettings();
    if (!scope.active) return;
    this.config = config;
    this.rearm();
    await scope.add(listen(UI_EVENTS.resetStandup, () => this.rearm()));
    await scope.add(listen(UI_EVENTS.standupAck, () => this.ack())); // 旧入口兼容
    await scope.add(listen<{ id: string; kind: string }>(STATE_EVENTS.appAlertAcked, e => {
      if (e.payload?.kind === "standup" && e.payload.id === this.alertId) this.ack();
    }));
    await scope.add(listen(STATE_EVENTS.settingsChanged, () => {
      void this.reloadConfig(scope).catch(() => undefined);
    }));
    await scope.add(listen<{ presence: string }>(STATE_EVENTS.presenceChanged, e => {
      if (e.payload?.presence === "active") this.tick();
    }));
    await scope.add(subscribeHeartbeat(() => this.tick()));
  }

  /** 仅释放本服务资源和状态，用于 HMR/退出，不清理其他服务的提醒。 */
  dispose(): void {
    this.scope?.dispose();
    this.starting = null;
    this.rearm();
    petState.clearSystem("standup");
  }

  private async reloadConfig(scope: ServiceScope): Promise<void> {
    const next = await loadSettings();
    if (!scope.active) return;
    const changed = next.standupIntervalMin !== this.config.standupIntervalMin;
    this.config = next;
    if (changed) this.rearm();
  }

  private rearm(): void {
    if (this.alertId) this.pendingDismiss.add(this.alertId);
    this.alertId = null;
    this.state = "armed";
    this.dismissAt = 0;
    this.deadline = Date.now() + this.config.standupIntervalMin * 60_000;
    petState.clearSystem("standup");
    this.flushDismissals();
  }

  private tick(): void {
    this.flushDismissals();
    if (this.state === "fired") {
      // 超时同样比较时间戳，后台 setTimeout 不执行也不会留下永久弹窗。
      if (this.dismissAt > 0 && Date.now() >= this.dismissAt) this.ack();
      return;
    }
    if (Date.now() < this.deadline || presenceService.current === "away" || this.deliveryInFlight) return;
    void this.fire();
  }

  private async fire(): Promise<void> {
    const id = `standup:${crypto.randomUUID()}`;
    this.alertId = id;
    this.state = "fired";
    this.deliveryInFlight = true;
    const scope = this.scope;
    try {
      await showAppAlert({ id, kind: "standup", title: "该站起来啦！", body: `已经陪你坐了 ${this.config.standupIntervalMin} 分钟，起来活动一下吧` });
      if (this.alertId !== id || !scope?.active) {
        // 投递期间用户重置/退出：清理刚到达的旧提醒，不得污染下一轮。
        this.pendingDismiss.add(id);
        this.flushDismissals();
        return;
      }
      this.dismissAt = Date.now() + ALERT_AUTO_DISMISS_MS;
      petState.setSystem("alert", undefined, "standup");
      if (this.config.notificationsEnabled) void notify("该站起来啦 🧍", "点击麻薯的提醒弹窗重置计时");
    } catch {
      if (this.alertId === id) {
        this.alertId = null;
        this.state = "armed"; // deadline 不变，下一 tick 重试
      }
    } finally {
      this.deliveryInFlight = false;
    }
  }

  private ack(): void {
    if (this.state !== "fired") return;
    this.rearm();
    petState.setSystem("stretch", 2, "standup");
  }

  private flushDismissals(): void {
    for (const id of this.pendingDismiss) {
      if (this.dismissing.has(id)) continue;
      this.dismissing.add(id);
      void dismissAppAlert(id).then(() => this.pendingDismiss.delete(id)).catch(() => undefined)
        .finally(() => this.dismissing.delete(id));
    }
  }
}

export type PomodoroPhase = "idle" | "focus" | "break";
/** 广播包含配置时长，空闲 UI 也能显示真实设置。 */
export interface PomodoroStatus { phase: PomodoroPhase; remainingSec: number; focusMin: number; }

/** 宠物窗是唯一权威；阶段切换同步完成，可见提醒以稳定 id 异步投递并重试。 */
export class PomodoroService {
  phase: PomodoroPhase = "idle";
  private deadline = 0;
  private activeBreakMin = 5;
  private roundId = "";
  private config = defaults();
  private starting: Promise<void> | null = null;
  private scope: ServiceScope | null = null;
  private pendingAlerts = new Map<string, AppAlert>();
  private delivering = new Set<string>();

  /** 失败可重试，重复初始化不会注册多套跨窗监听与心跳。 */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    const scope = new ServiceScope();
    this.scope = scope;
    this.starting = this.initialize(scope).catch(error => {
      scope.dispose();
      if (this.scope === scope) this.starting = null;
      throw error;
    });
    return this.starting;
  }

  private async initialize(scope: ServiceScope): Promise<void> {
    const config = await loadSettings();
    if (!scope.active) return;
    this.config = config;
    await scope.add(listen(STATE_EVENTS.settingsChanged, () => {
      void loadSettings().then(c => { if (scope.active) { this.config = c; this.broadcast(); } }).catch(() => undefined);
    }));
    await scope.add(listen<{ minutes?: unknown; requestId?: string }>(STATE_EVENTS.pomodoroStart, e => {
      const min = e.payload?.minutes;
      const result = min != null && typeof min !== "number"
        ? { ok: false as const, error: "专注时长必须是数字" } : this.startFocus(min ?? undefined);
      this.reply(e.payload?.requestId, result);
    }));
    await scope.add(listen<{ requestId?: string }>(STATE_EVENTS.pomodoroStop, e => {
      this.stop();
      this.reply(e.payload?.requestId, { ok: true, data: this.status() });
    }));
    await scope.add(listen<{ requestId?: string }>(STATE_EVENTS.pomodoroQuery, e => {
      this.tick(); // 刚唤醒时查询也先结算到期阶段
      this.reply(e.payload?.requestId, { ok: true, data: this.status() });
    }));
    await scope.add(subscribeHeartbeat(() => this.tick()));
  }

  /** 卸载常驻服务时释放监听；用户的停止按钮仅调用 stop，不卸载服务。 */
  dispose(): void {
    this.scope?.dispose();
    this.starting = null;
    this.stop();
  }

  /** 执行边界再次校验，防止广播绕过工具校验或并发启动穿过 UI 缓存。 */
  startFocus(minutes?: number): PomodoroResult {
    if (this.phase === "focus") return { ok: false, error: "已有番茄钟在专注中，请先停止或等它结束" };
    const min = minutes ?? this.config.pomodoroFocusMin;
    if (!Number.isFinite(min) || min < 5 || min > 90) return { ok: false, error: "专注时长需在 5~90 分钟之间" };
    this.roundId = crypto.randomUUID();
    this.phase = "focus";
    this.deadline = Date.now() + min * 60_000;
    this.activeBreakMin = this.config.pomodoroBreakMin;
    petState.setSystem("focus", undefined, "pomodoro");
    this.broadcast();
    return { ok: true, data: this.status() };
  }

  /** 停止只释放番茄钟自己的状态，已经到点的提醒仍保留供用户查看。 */
  stop(): void {
    if (this.phase === "idle") return;
    this.phase = "idle";
    petState.clearSystem("pomodoro");
    this.broadcast();
  }

  /** UI 与工具共用快照，剩余时间根据 deadline 计算，不做秒数累减。 */
  status(): PomodoroStatus {
    return { phase: this.phase, remainingSec: this.phase === "idle" ? 0 : Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000)), focusMin: this.config.pomodoroFocusMin };
  }

  private tick(): void {
    this.flushAlerts();
    if (this.phase === "idle" || Date.now() < this.deadline) {
      if (this.phase !== "idle") this.broadcast();
      return;
    }
    if (this.phase === "focus") {
      this.phase = "break";
      // 睡过专注结束时刻：从恢复时开始一次完整休息，不连发多个阶段通知。
      this.deadline = Date.now() + this.activeBreakMin * 60_000;
      petState.setSystem("break", undefined, "pomodoro");
      this.queueAlert("focus", "专注完成 🍅", `休息 ${this.activeBreakMin} 分钟，麻薯等你回来`);
    } else {
      this.phase = "idle";
      petState.clearSystem("pomodoro");
      this.queueAlert("break", "休息结束 ☕", "准备好就开始下一轮番茄钟吧");
    }
    this.broadcast();
  }

  private queueAlert(phase: string, title: string, body: string): void {
    const id = `pomodoro:${this.roundId}:${phase}`;
    this.pendingAlerts.set(id, { id, kind: "pomodoro", title, body });
    this.flushAlerts();
  }

  private flushAlerts(): void {
    for (const [id, alert] of this.pendingAlerts) {
      if (this.delivering.has(id)) continue;
      this.delivering.add(id);
      void showAppAlert(alert).then(() => {
        this.pendingAlerts.delete(id);
        if (this.config.notificationsEnabled) void notify(alert.title, alert.body);
      }).catch(() => undefined).finally(() => this.delivering.delete(id));
    }
  }

  private broadcast(): void { void emit(STATE_EVENTS.pomodoroChanged, this.status()).catch(() => undefined); }
  private reply(requestId: string | undefined, result: PomodoroResult): void {
    if (typeof requestId === "string") void emit(STATE_EVENTS.pomodoroResult, { requestId, result }).catch(() => undefined);
  }
}

/** 服务只在宠物窗启动，隐藏窗口不会卸载这些单例。 */
export const standupService = new StandupService();
export const pomodoroService = new PomodoroService();
