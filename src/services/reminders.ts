/**
 * ReminderService —— 自然语言提醒的双组件（learning/08 §5.4）：
 *
 * - **ReminderStore**（聊天窗，Agent 工具的 ctx.services.reminders）：CRUD + 变更广播。
 *   create 的"硬校验"在工具层（时间解析/过去/30 天 horizon），Store 只管落库。
 * - **ReminderScheduler**（宠物窗常驻轮询）：原生心跳每秒扫 `active AND fire_at<=now`，
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
import { subscribeHeartbeat } from "@/services/heartbeat";
import { showAppAlert } from "@/services/alerts";

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

/** 提醒 CRUD 只负责持久状态，调度生命周期独立，聊天窗关闭也不会撤销提醒。 */
export class ReminderStore {
  private listeners = new Set<() => void>();

  /** 按需等待就绪；连接初次失败后下次访问可重试，模块导入不会产生无人处理的拒绝。 */
  get ready(): Promise<void> {
    return getDb().then(() => undefined);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async broadcast(): Promise<void> {
    // 写入已成功时，UI 广播失败不能把创建报告为失败，否则用户重试会产生两条提醒。
    await emit(STATE_EVENTS.remindersChanged).catch(() => undefined);
    for (const fn of this.listeners) fn();
  }

  /** 工具负责时间语义；服务守住能持久化/展示的底线，避免创建无法交付的记录。 */
  async create(text: string, fireAtMs: number): Promise<Reminder> {
    const body = text.trim();
    if (!body) throw new Error("提醒内容不能为空");
    if (!Number.isFinite(fireAtMs)) throw new Error("提醒时间无效");
    const db = await getDb();
    const now = Date.now();
    const result = await db.execute(
      "INSERT INTO reminders (text, fire_at, status, created_at, acknowledged_at) VALUES ($1,$2,'active',$3,NULL)",
      [body, fireAtMs, now],
    );
    await this.broadcast();
    return {
      id: result.lastInsertId as number,
      text: body,
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
    // 查询与写入之间可能被调度器认领；取消也用条件更新，不能把 fired 覆盖回 cancelled。
    const result = await db.execute("UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND status = 'active'", [id]);
    if (result.rowsAffected !== 1) return null;
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

/**
 * 只认领一次，但交付失败允许重试：fired 的含义是已交付可见弹窗，而非仅执行了 UPDATE。
 * 生命周期代号使 stop 或快速重启期间仍在等待的 SQL 不会继续弹窗。
 */
export class ReminderScheduler {
  private notificationsEnabled = true;
  private running = false;
  private generation = 0;
  private starting: Promise<void> | null = null;
  private inFlight: Promise<void> | null = null;
  private cleanup: Array<() => void> = [];
  private pendingRollbacks = new Map<number, number>();
  private pendingAcknowledgements = new Map<number, number>();
  private delivered = new Set<number>();

  /** 重复启动共用初始化；启动立即补扫，不让已过期提醒再等一个轮询周期。 */
  start(): Promise<void> {
    if (this.running) return this.starting ?? Promise.resolve();
    this.running = true;
    this.delivered.clear(); // 新生命周期需要恢复原生队列，不沿用上次进程内交付记忆。
    const generation = ++this.generation;
    this.starting = this.initialize(generation).catch(error => {
      // 注册事件失败时释放已安装的监听，允许下次显式 start 重试。
      if (this.isCurrent(generation)) this.stop();
      throw error;
    });
    return this.starting;
  }

  /** 释放心跳及跨窗口订阅；未完成的 SQL 在下一 await 边界校验代号后退出。 */
  stop(): void {
    this.running = false;
    this.generation += 1;
    this.starting = null;
    for (const off of this.cleanup.splice(0)) off();
  }

  private isCurrent(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private isAway(): boolean {
    return presenceService.current === "away";
  }

  private async initialize(generation: number): Promise<void> {
    await this.reloadConfig(generation);
    const keep = (off: () => void) => {
      if (this.isCurrent(generation)) this.cleanup.push(off);
      else off();
    };
    keep(await listen(STATE_EVENTS.settingsChanged, () => void this.reloadConfig(generation)));
    keep(await listen(STATE_EVENTS.remindersChanged, () => void this.scan()));
    keep(await listen<{ kind: string; id: string }>(STATE_EVENTS.appAlertAcked, e => {
      if (e.payload?.kind !== "reminder") return;
      const id = /^reminder:(\d+)$/.exec(e.payload.id)?.[1];
      if (!id) return;
      const reminderId = Number(id);
      if (!Number.isSafeInteger(reminderId)) return;
      this.delivered.add(reminderId);
      this.pendingAcknowledgements.set(reminderId, Date.now());
      void this.scan();
    }));
    keep(await listen<{ presence: string }>(STATE_EVENTS.presenceChanged, e => {
      if (e.payload?.presence === "active") void this.scan();
    }));
    if (!this.isCurrent(generation)) return;
    keep(await subscribeHeartbeat(() => void this.scan()));
    if (this.isCurrent(generation)) await this.scan();
  }

  private async reloadConfig(generation: number): Promise<void> {
    try {
      const settings = await loadSettings();
      if (this.isCurrent(generation)) this.notificationsEnabled = settings.notificationsEnabled;
    } catch {
      // 设置临时失败不影响独立的可见提醒通道，保留上次开关值即可。
    }
  }

  /** SQL 再慢也最多一轮在途；异常被接住，下一次心跳重新尝试，不制造未处理拒绝。 */
  private scan(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    this.inFlight = this.tick(generation).catch(() => undefined).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async tick(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const now = Date.now();
    const db = await getDb();
    if (!this.isCurrent(generation)) return;
    // 显示失败后的回滚也可能遇到临时锁定；保留认领令牌，下次扫描先恢复它们。
    for (const [id, claimedAt] of this.pendingRollbacks) {
      await db.execute(
        "UPDATE reminders SET status = 'active', fired_at = NULL WHERE id = $1 AND status = 'fired' AND fired_at = $2",
        [id, claimedAt],
      );
      this.pendingRollbacks.delete(id);
    }
    // 确认先于恢复队列处理；写库失败保留待确认令牌，避免重放用户刚关掉的提醒。
    for (const [id, acknowledgedAt] of this.pendingAcknowledgements) {
      await db.execute(
        "UPDATE reminders SET acknowledged_at = $1 WHERE id = $2 AND status = 'fired' AND acknowledged_at IS NULL",
        [acknowledgedAt, id],
      );
      this.pendingAcknowledgements.delete(id);
    }
    if (!this.isCurrent(generation) || this.isAway()) return;
    // fired 只代表交付；用户未确认前，进程重启也必须恢复。原生按同一个 id 去重，
    // delivered Set 防止每秒重发；恢复不重复发系统通知。
    const unacknowledged = await db.select<ReminderRow[]>(
      "SELECT * FROM reminders WHERE status = 'fired' AND acknowledged_at IS NULL ORDER BY fire_at ASC",
    );
    for (const row of unacknowledged) {
      if (!this.isCurrent(generation) || this.isAway()) return;
      if (this.delivered.has(row.id)) continue;
      try {
        await showAppAlert({ id: `reminder:${row.id}`, kind: "reminder", title: "到点提醒", body: row.text });
        this.delivered.add(row.id);
      } catch {
        // 记录仍为 fired + 未确认，下一心跳继续恢复。
      }
    }
    const due = await db.select<ReminderRow[]>(
      "SELECT * FROM reminders WHERE status = 'active' AND fire_at <= $1 ORDER BY fire_at ASC",
      [now],
    );
    for (const row of due) {
      // 用户 away：不认领（行保持 active），恢复在场后补发（08 §5.4）
      if (!this.isCurrent(generation) || this.isAway()) return;

      // 认领：状态迁移幂等——rowsAffected===1 才是本实例抢到
      const claimedAt = Date.now();
      const claim = await db.execute(
        "UPDATE reminders SET status = 'fired', fired_at = $1 WHERE id = $2 AND status = 'active'",
        [claimedAt, row.id],
      );
      if ((claim.rowsAffected ?? 0) !== 1) continue;

      try {
        if (!this.isCurrent(generation) || this.isAway()) {
          throw new Error("提醒调度已停止或用户离开");
        }
        // 即使系统通知关闭/没有权限，也必须展示包含提醒正文的应用弹窗。
        // Rust 负责按 id 去重排队；调用成功意味着已接收并展示/入队。
        await showAppAlert({ id: `reminder:${row.id}`, kind: "reminder", title: "到点提醒", body: row.text });
      } catch {
        // 只有这次认领仍有效才还原；显示失败不能永久吃掉提醒。
        this.pendingRollbacks.set(row.id, claimedAt);
        await db.execute(
          "UPDATE reminders SET status = 'active', fired_at = NULL WHERE id = $1 AND status = 'fired' AND fired_at = $2",
          [row.id, claimedAt],
        );
        this.pendingRollbacks.delete(row.id);
        continue;
      }
      this.delivered.add(row.id);
      petState.setSystem("alert", 8, "reminder"); // 临时提示到期后恢复站立/专注状态
      if (this.notificationsEnabled) void notify("⏰ 到点提醒", row.text).catch(() => undefined);
      await emit(STATE_EVENTS.remindersChanged).catch(() => undefined);
    }
  }
}

/** 各窗口单例：聊天窗用 reminderStore，宠物窗用 reminderScheduler */
export const reminderStore = new ReminderStore();
export const reminderScheduler = new ReminderScheduler();
