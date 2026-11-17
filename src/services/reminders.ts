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
import { historyStore } from "@/agent/memory/history-store";
import { petState } from "@/services/pet-state";
import { presenceService } from "@/services/presence";
import { notify } from "@/services/notifications";
import { loadSettings } from "@/services/settings";
import { STATE_EVENTS } from "@/shared/events";
import { subscribeHeartbeat } from "@/services/heartbeat";
import { showAppAlert } from "@/services/alerts";
import { formatBatchBody } from "@/services/system-events";
import { parseRepeat, nextOccurrence, type Repeat } from "@/services/recurrence";

export interface Reminder {
  id: number;
  text: string;
  /** epoch ms（绝对时间，跨时区安全——learning/08 §5.4） */
  fireAt: number;
  status: "active" | "fired" | "cancelled";
  createdAt: number;
  firedAt?: number;
  /** 重复规则（v0.13.0）：none 一次性；daily/weekdays/weekly 触发后自动排下一次 */
  repeat: Repeat;
  /** 同一串周期提醒的分组 id（v0.13.0，仅 repeat != none 时有值） */
  seriesId?: string;
}

interface ReminderRow {
  id: number;
  text: string;
  fire_at: number;
  status: "active" | "fired" | "cancelled";
  created_at: number;
  fired_at: number | null;
  repeat: string | null;
  series_id: string | null;
}

const rowToReminder = (r: ReminderRow): Reminder => ({
  id: r.id,
  text: r.text,
  fireAt: r.fire_at,
  status: r.status,
  createdAt: r.created_at,
  repeat: parseRepeat(r.repeat),
  ...(r.fired_at != null ? { firedAt: r.fired_at } : {}),
  ...(r.series_id ? { seriesId: r.series_id } : {}),
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
  async create(text: string, fireAtMs: number, repeat: Repeat = "none"): Promise<Reminder> {
    const body = text.trim();
    if (!body) throw new Error("提醒内容不能为空");
    if (!Number.isFinite(fireAtMs)) throw new Error("提醒时间无效");
    const db = await getDb();
    const now = Date.now();
    const seriesId = repeat === "none" ? null : crypto.randomUUID();
    const result = await db.execute(
      "INSERT INTO reminders (text, fire_at, status, created_at, acknowledged_at, repeat, series_id) VALUES ($1,$2,'active',$3,NULL,$4,$5)",
      [body, fireAtMs, now, repeat, seriesId],
    );
    await this.broadcast();
    return {
      id: result.lastInsertId as number,
      text: body,
      fireAt: fireAtMs,
      status: "active",
      createdAt: now,
      repeat,
      ...(seriesId ? { seriesId } : {}),
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
  /**
   * 刚从长休眠恢复（v0.11.0）：下次扫描要把过期提醒**合并成一条**交付，
   * 而不是按原逻辑逐条弹——否则合盖一夜再打开会连弹一串。
   */
  private burstResume = false;

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
    // 长休眠恢复（v0.11.0）：标记"下次扫描合并交付"，并立即扫一次
    keep(await listen<{ gapMs?: number; burst?: boolean }>(STATE_EVENTS.systemResumed, event => {
      if (event.payload?.burst === true) this.burstResume = true;
      void this.scan();
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
    // 刚从长休眠恢复：先把积压的过期提醒合并成一条，再走常规单条通道。
    // 只有 >=2 条才合并；单条仍走下面的常规路径（保留原文与原文交互）。
    if (this.burstResume) {
      this.burstResume = false;
      await this.coalesceOverdue(now, generation);
      if (!this.isCurrent(generation) || this.isAway()) return;
    }
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
        if (!this.isCurrent(generation)) return;
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
      // 原生已接受的队列保留，但晚于 stop 返回的旧请求不能污染新生命周期。
      // 未确认 fired 仍在 SQLite，下一次 start 会按相同 id 恢复而不重复通知。
      if (!this.isCurrent(generation)) return;
      this.delivered.add(row.id);
      petState.setSystem("alert", 8, "reminder"); // 临时提示到期后恢复站立/专注状态
      if (this.notificationsEnabled) void notify("⏰ 到点提醒", row.text).catch(() => undefined);
      await emit(STATE_EVENTS.remindersChanged).catch(() => undefined);
      // 触发事件写入聊天历史（learning/08 §5.4 设计兑现）：用户打开聊天窗能看到
      // "刚才提醒过什么"，模型下轮对话也能自然衔接（"我刚提醒过你喝水"）。
      // assistant 角色进模型上下文是信息而非污染；落库失败不影响提醒本身（append 内部吞错）。
      void historyStore.append([{ role: "assistant", content: `⏰ 到点提醒：${row.text}` }]);
      // 周期提醒（v0.13.0）：交付成功后立刻排下一次，失败则什么都不做（原行已被回滚成 active）
      await this.scheduleNext(row, Date.now());
    }
    // 待办到期（v0.13.0）：同一拍里顺手扫一次，与提醒共用投递链路
    await this.scanTodoDue(now, generation);
  }

  /**
   * 周期提醒排下一次（v0.13.0）：**插入新行**而不是改原行。
   *
   * 保留原行 = 触发历史可追溯（"我确实提醒过你三次"）；新行 = 下一次待触发。
   * 下一次一律从 `now` 之后算：关机三天再开机也只补一次，然后落到下一个未来时刻。
   */
  private async scheduleNext(row: ReminderRow, now: number): Promise<void> {
    const repeat = parseRepeat(row.repeat);
    if (repeat === "none") return;
    const next = nextOccurrence(row.fire_at, repeat, now);
    if (next === null) return;
    const db = await getDb();
    await db.execute(
      "INSERT INTO reminders (text, fire_at, status, created_at, acknowledged_at, repeat, series_id) VALUES ($1,$2,'active',$3,NULL,$4,$5)",
      [row.text, next, now, repeat, row.series_id ?? crypto.randomUUID()],
    );
  }

  /**
   * 待办到期扫描（v0.13.0）：与提醒共用同一条投递链路（同一个原生队列 + 通知 + 历史）。
   *
   * 状态字段选 `todos.due_notified_at` 而不是复用 `reminders` 表：待办是用户清单，
   * 到期只是它的一个时间属性；塞进提醒表会让"清单"和"提醒"两份数据互相打架。
   * 认领用条件更新（`WHERE due_notified_at IS NULL`），多窗口/重试都只会弹一次。
   */
  private async scanTodoDue(now: number, generation: number): Promise<void> {
    const db = await getDb();
    if (!this.isCurrent(generation)) return;
    const rows = await db.select<Array<{ id: number; title: string }>>(
      "SELECT id, title FROM todos WHERE done = 0 AND due_at IS NOT NULL AND due_at <= $1 AND due_notified_at IS NULL ORDER BY due_at ASC",
      [now],
    );
    for (const row of rows) {
      if (!this.isCurrent(generation) || this.isAway()) return;
      const claim = await db.execute(
        "UPDATE todos SET due_notified_at = $1 WHERE id = $2 AND due_notified_at IS NULL",
        [now, row.id],
      );
      if ((claim.rowsAffected ?? 0) !== 1) continue;
      try {
        await showAppAlert({ id: `todo:${row.id}`, kind: "reminder", title: "待办到期", body: row.title });
      } catch {
        // 显示失败要能重试：把标记清掉（比对时间戳，避免清掉别人的认领）
        await db
          .execute("UPDATE todos SET due_notified_at = NULL WHERE id = $1 AND due_notified_at = $2", [row.id, now])
          .catch(() => undefined);
        continue;
      }
      if (!this.isCurrent(generation)) return;
      petState.setSystem("alert", 8, "todo");
      if (this.notificationsEnabled) void notify("📌 待办到期", row.title).catch(() => undefined);
      void historyStore.append([{ role: "assistant", content: `📌 待办到期：${row.title}` }]);
    }
  }

  /**
   * 合并交付积压提醒（v0.11.0，长休眠恢复专用）。
   *
   * 合盖一夜再打开时，`active AND fire_at <= now` 可能有五条——常规通道会连弹五个
   * 弹窗，这正是要修的问题。这里把它们认领并合成**一条**「N 条提醒到点了」，
   * 正文按原顺序列出（最多 5 条，其余「等 N 条」），信息不丢、打扰只一次。
   *
   * 认领时一并写 `acknowledged_at`：这条合并提醒就是它们的交付凭证。不写的话，
   * 下一拍会被"未确认提醒恢复"逻辑逐条重新弹出来——正好绕回要避免的轰炸。
   * 少于两条不合并：单条走常规通道，保留原文与按钮交互。
   */
  private async coalesceOverdue(now: number, generation: number): Promise<void> {
    const db = await getDb();
    if (!this.isCurrent(generation)) return;
    const rows = await db.select<ReminderRow[]>(
      "SELECT * FROM reminders WHERE status = 'active' AND fire_at <= $1 ORDER BY fire_at ASC",
      [now],
    );
    if (rows.length < 2) return;
    const claimed: ReminderRow[] = [];
    for (const row of rows) {
      const claim = await db.execute(
        "UPDATE reminders SET status = 'fired', fired_at = $1, acknowledged_at = $1 WHERE id = $2 AND status = 'active'",
        [now, row.id],
      );
      if ((claim.rowsAffected ?? 0) === 1) claimed.push(row);
    }
    if (claimed.length === 0) return;
    // 周期提醒即使被合并交付，也必须继续排下一次——否则一条"每天 9 点"的提醒
    // 会因为"睡了一夜被合并"而彻底消失。
    for (const row of claimed) await this.scheduleNext(row, now);
    try {
      await showAppAlert({
        id: `reminder:batch:${now}`,
        kind: "reminder",
        title: `${claimed.length} 条提醒到点了`,
        body: formatBatchBody(claimed.map(row => row.text)),
      });
      // 提醒历史同样留一条汇总，聊天窗里能看到"那晚错过什么"
      void historyStore.append([
        { role: "assistant", content: `⏰ 恢复后合并提醒：${formatBatchBody(claimed.map(row => row.text))}` },
      ]);
    } catch {
      // 汇总弹窗失败就不再退回逐条补发（那正是要避免的轰炸），只留控制台痕迹。
      console.error("[reminders] 合并提醒显示失败，已按已交付处理", claimed.length);
    }
  }
}

/** 各窗口单例：聊天窗用 reminderStore，宠物窗用 reminderScheduler */
export const reminderStore = new ReminderStore();
export const reminderScheduler = new ReminderScheduler();
