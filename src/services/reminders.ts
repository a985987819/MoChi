/**
 * ReminderService —— 自然语言提醒的双组件（learning/08 §5.4）：
 *
 * - **ReminderStore**（聊天窗，Agent 工具的 ctx.services.reminders）：CRUD + 变更广播。
 *   create 的"硬校验"在工具层（时间解析/过去/30 天 horizon），Store 只管落库。
 * - **ReminderScheduler**（宠物窗常驻轮询）：每 30s 扫 `active AND fire_at<=now`，
 *   用 `UPDATE ... WHERE status='active'` **认领**（rowsAffected===1 才算抢到）——
 *   状态迁移幂等，即使多个实例轮询也只触发一次（08：补发一次）。
 *   用户 away 时**不认领**（行保持 active），恢复在场后下一 tick 补发。
 *
 * 单一事实源 = SQLite 两窗口共享；无跨窗口状态同步问题。
 */

import { emit, listen } from "@tauri-apps/api/event";
import { getDb } from "@/services/db";
import { petState } from "@/services/pet-state";
import { presenceService } from "@/services/presence";
import { notify } from "@/services/notifications";
import { loadSettings } from "@/services/settings";
import { STATE_EVENTS } from "@/shared/events";

export interface Reminder {
  id: number;
  text: string;
  /** epoch ms（绝对时间，跨时区安全——learning/08 §5.4） */
  fireAt: number;
  status: "active" | "fired" | "cancelled";
  createdAt: number;
  firedAt?: number;
}

interface ReminderRow {
  id: number;
  text: string;
  fire_at: number;
  status: "active" | "fired" | "cancelled";
  created_at: number;
  fired_at: number | null;
}

const rowToReminder = (r: ReminderRow): Reminder => ({
  id: r.id,
  text: r.text,
  fireAt: r.fire_at,
  status: r.status,
  createdAt: r.created_at,
  ...(r.fired_at != null ? { firedAt: r.fired_at } : {}),
});

// ── Store（聊天窗：工具的写入口）──────────────────────────────────────

export class ReminderStore {
  readonly ready: Promise<void>;
  private listeners = new Set<() => void>();

  constructor() {
    this.ready = getDb().then(() => undefined);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async broadcast(): Promise<void> {
    await emit(STATE_EVENTS.remindersChanged);
    for (const fn of this.listeners) fn();
  }

  /** 工具已完成硬校验，这里只落库（learning/08 §5.2 责任切分） */
  async create(text: string, fireAtMs: number): Promise<Reminder> {
    const db = await getDb();
    const now = Date.now();
    const result = await db.execute(
      "INSERT INTO reminders (text, fire_at, status, created_at) VALUES ($1,$2,'active',$3)",
      [text, fireAtMs, now],
    );
    await this.broadcast();
    return {
      id: result.lastInsertId as number,
      text,
      fireAt: fireAtMs,
      status: "active",
      createdAt: now,
    };
  }

  /** destructive-lite：返回被取消条目（learning/07 §4.3 可追溯） */
  async cancel(id: number): Promise<Reminder | null> {
    const db = await getDb();
    const rows = await db.select<ReminderRow[]>(
      "SELECT * FROM reminders WHERE id = $1 AND status = 'active'",
      [id],
    );
    if (rows.length === 0) return null;
    await db.execute("UPDATE reminders SET status = 'cancelled' WHERE id = $1", [id]);
    await this.broadcast();
    return rowToReminder(rows[0]);
  }

  async listActive(): Promise<Reminder[]> {
    const db = await getDb();
    const rows = await db.select<ReminderRow[]>(
      "SELECT * FROM reminders WHERE status = 'active' ORDER BY fire_at ASC",
    );
    return rows.map(rowToReminder);
  }
}

// ── Scheduler（宠物窗：到点触发）──────────────────────────────────────

const TICK_MS = 30_000;

export class ReminderScheduler {
  private timer: number | null = null;
  private notificationsEnabled = true;

  async start(): Promise<void> {
    this.notificationsEnabled = (await loadSettings()).notificationsEnabled;
    void listen(STATE_EVENTS.settingsChanged, async () => {
      this.notificationsEnabled = (await loadSettings()).notificationsEnabled;
    });
    this.timer = window.setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const db = await getDb();
    const due = await db.select<ReminderRow[]>(
      "SELECT * FROM reminders WHERE status = 'active' AND fire_at <= $1 ORDER BY fire_at ASC",
      [now],
    );
    for (const row of due) {
      // 用户 away：不认领（行保持 active），恢复在场后补发（08 §5.4）
      if (presenceService.current === "away") return;

      // 认领：状态迁移幂等——rowsAffected===1 才是本实例抢到
      const claim = await db.execute(
        "UPDATE reminders SET status = 'fired', fired_at = $1 WHERE id = $2 AND status = 'active'",
        [Date.now(), row.id],
      );
      if ((claim.rowsAffected ?? 0) !== 1) continue;

      petState.setSystem("alert", 8); // 轻量提示（区别于站立提醒的粘性 alert）
      if (this.notificationsEnabled) void notify("⏰ 到点提醒", row.text);
      await emit(STATE_EVENTS.remindersChanged);
    }
  }
}

/** 各窗口单例：聊天窗用 reminderStore，宠物窗用 reminderScheduler */
export const reminderStore = new ReminderStore();
export const reminderScheduler = new ReminderScheduler();
