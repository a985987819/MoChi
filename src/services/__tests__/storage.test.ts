// Node 22 内置测试驱动；v0.9.0 起 devDependencies 有 @types/node，类型声明可用。
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { STATE_EVENTS } from "@/shared/events";

interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number; lastInsertRowid: number };
    all(...args: unknown[]): unknown[];
  };
  close(): void;
}
const deps = vi.hoisted(() => ({
  db: null as Sqlite | null,
  presence: { current: "active" },
  notify: vi.fn(async () => {}),
  failWrite: false,
  notificationsEnabled: true,
  failRead: false,
  dueReads: 0,
  readBlock: null as Promise<void> | null,
  settingsLoads: 0,
  showAlert: vi.fn(),
  rollbackFailures: 0,
  claimBlock: null as Promise<void> | null,
  migrationFailures: 0,
}));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: async () => ({
  execute: async (sql: string, args: unknown[] = []) => {
    if (deps.failWrite) throw new Error("模拟写入失败");
    if (sql.includes("CASE WHEN status = 'fired'") && deps.migrationFailures > 0) {
      deps.migrationFailures -= 1;
      throw new Error("迁移回填临时失败");
    }
    if (sql.includes("SET status = 'active'") && deps.rollbackFailures > 0) {
      deps.rollbackFailures -= 1;
      throw new Error("回滚时临时锁定");
    }
    const result = deps.db!.prepare(sql.replace(/\$\d+/g, "?")).run(...args);
    if (sql.includes("SET status = 'fired'") && deps.claimBlock) await deps.claimBlock;
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  },
  select: async (sql: string, args: unknown[] = []) => {
    if (sql.includes("fire_at <=")) {
      deps.dueReads += 1;
      if (deps.failRead) throw new Error("模拟临时查询失败");
      if (deps.readBlock) await deps.readBlock;
    }
    return deps.db!.prepare(sql.replace(/\$\d+/g, "?")).all(...args);
  },
}) } }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => null }) }));
vi.mock("@/services/settings", () => ({ loadSettings: async () => {
  deps.settingsLoads += 1;
  return { notificationsEnabled: deps.notificationsEnabled };
} }));
vi.mock("@/services/presence", () => ({ presenceService: deps.presence }));
vi.mock("@/services/notifications", () => ({ notify: deps.notify }));
vi.mock("@/services/alerts", () => ({ showAppAlert: deps.showAlert }));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  mockIPC(() => undefined, { shouldMockEvents: true });
  // 使用真正 SQLite 执行生产 DDL/CRUD，测试跨过 SQL 语法和持久状态边界。
  const SqliteDatabase = DatabaseSync as unknown as new (path: string) => Sqlite;
  deps.db = new SqliteDatabase(":memory:");
  deps.presence.current = "active";
  deps.failWrite = false;
  deps.notificationsEnabled = true;
  deps.failRead = false;
  deps.dueReads = 0;
  deps.readBlock = null;
  deps.settingsLoads = 0;
  deps.notify.mockClear();
  deps.showAlert.mockReset().mockResolvedValue(undefined);
  deps.rollbackFailures = 0;
  deps.claimBlock = null;
  deps.migrationFailures = 0;
});
afterEach(() => {
  vi.clearAllTimers(); clearMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); deps.db?.close();
});

it("待办新增、完成、删除与服务重建后的恢复", async () => {
  const { TodoService, todoService } = await import("@/services/todos");
  await todoService.ready;
  const todo = await todoService.add("  检查番茄钟  ");
  expect(todo.title).toBe("检查番茄钟");
  const restored = new TodoService();
  await restored.ready;
  expect(restored.list()).toEqual([todo]);
  await restored.complete(todo.id);
  expect(restored.list()).toHaveLength(0);
  expect(restored.list(true)[0].done).toBe(true);
  await restored.remove(todo.id);
  expect(restored.snapshot()).toEqual([]);
});

it("待办写入失败时不能在内存中显示成已完成或已删除", async () => {
  const { todoService } = await import("@/services/todos");
  await todoService.ready;
  const todo = await todoService.add("数据必须一致");
  deps.failWrite = true;
  await expect(todoService.complete(todo.id)).rejects.toThrow();
  expect(todoService.list()).toHaveLength(1);
  await expect(todoService.remove(todo.id)).rejects.toThrow();
  expect(todoService.snapshot()).toHaveLength(1);
});

it("提醒创建、排序、取消，已取消记录不触发", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  const later = await reminderStore.create("晚一点", Date.now() + 60_000);
  const first = await reminderStore.create("先取消", Date.now() + 1000);
  expect((await reminderStore.listActive()).map(r => r.id)).toEqual([first.id, later.id]);
  expect((await reminderStore.cancel(first.id))?.text).toBe("先取消");
  expect(await reminderStore.cancel(first.id)).toBeNull();
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deps.notify).not.toHaveBeenCalled();
  scheduler.stop();
});

it("离开期间推迟提醒，恢复后只触发一次，调度器重建不重复", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  await reminderStore.create("喝水", Date.now() + 1000);
  deps.presence.current = "away";
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deps.notify).not.toHaveBeenCalled();
  expect(await reminderStore.listActive()).toHaveLength(1);
  deps.presence.current = "active";
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deps.notify).toHaveBeenCalledTimes(1);
  scheduler.stop();
  const restarted = new ReminderScheduler();
  await restarted.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deps.notify).toHaveBeenCalledTimes(1);
  expect(await reminderStore.listActive()).toHaveLength(0);
  restarted.stop();
});

it("同一条提醒由两个调度器并发扫描也只触发一次", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  await reminderStore.create("唯一提醒", Date.now() - 1000);
  const schedulers = [new ReminderScheduler(), new ReminderScheduler()];
  await Promise.all(schedulers.map(s => s.start()));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deps.notify).toHaveBeenCalledTimes(1);
  schedulers.forEach(s => s.stop());
});

it("关闭通知后不发送系统通知，仍保存提醒已触发状态", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  deps.notificationsEnabled = false;
  await emit(STATE_EVENTS.settingsChanged);
  await reminderStore.create("通知正常", Date.now() + 1000);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deps.notify).not.toHaveBeenCalled();
  expect(await reminderStore.listActive()).toHaveLength(0);
  scheduler.stop();
});

it("并发取消同一提醒只有一次成功，不能覆盖已经被认领的状态", async () => {
  const { reminderStore } = await import("@/services/reminders");
  await reminderStore.ready;
  const row = await reminderStore.create("仅取消一次", Date.now() + 10_000);
  const results = await Promise.all([reminderStore.cancel(row.id), reminderStore.cancel(row.id)]);
  expect(results.filter(Boolean)).toHaveLength(1);
});

it("同时删除两条待办不影响第三条", async () => {
  const { todoService } = await import("@/services/todos");
  await todoService.ready;
  const first = await todoService.add("一");
  const second = await todoService.add("二");
  const third = await todoService.add("三");
  await Promise.all([todoService.remove(first.id), todoService.remove(second.id)]);
  expect(todoService.snapshot().map(t => t.id)).toEqual([third.id]);
});

it("调度器启动立即补发已经到期的提醒", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  await reminderStore.create("启动补发", Date.now() - 1000);
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  expect(deps.notify).toHaveBeenCalledWith("⏰ 到点提醒", "启动补发");
  scheduler.stop();
});

it("重复 start 不叠加轮询，stop 后设置监听也停止", async () => {
  const { ReminderScheduler } = await import("@/services/reminders");
  const scheduler = new ReminderScheduler();
  await Promise.all([scheduler.start(), scheduler.start()]);
  scheduler.stop();
  const reads = deps.dueReads;
  const loads = deps.settingsLoads;
  await vi.advanceTimersByTimeAsync(60_000);
  await emit(STATE_EVENTS.settingsChanged);
  expect(deps.dueReads).toBe(reads);
  expect(deps.settingsLoads).toBe(loads);
});

it("临时数据库失败不丢提醒，下一轮能恢复", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  await reminderStore.create("稍后恢复", Date.now() - 1000);
  deps.failRead = true;
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  expect(deps.notify).not.toHaveBeenCalled();
  deps.failRead = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deps.notify).toHaveBeenCalledTimes(1);
  scheduler.stop();
});

it("系统通知关闭时仍展示正文弹窗，原生弹窗失败则保留 active 等待下次重试", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  deps.notificationsEnabled = false;
  deps.showAlert.mockRejectedValueOnce(new Error("窗口暂不可用"));
  await reminderStore.create("一定可见的正文", Date.now() - 1000);
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  expect(await reminderStore.listActive()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await reminderStore.listActive()).toHaveLength(0);
  expect(deps.showAlert).toHaveBeenLastCalledWith(expect.objectContaining({ body: "一定可见的正文" }));
  expect(deps.notify).not.toHaveBeenCalled();
  scheduler.stop();
});

it("数据库扫描未返回时不发起重叠查询，stop 后不继续交付", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  await reminderStore.create("停止后不交付", Date.now() - 1000);
  let release: (() => void) | undefined;
  deps.readBlock = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new ReminderScheduler();
  const starting = scheduler.start();
  await vi.advanceTimersByTimeAsync(3000);
  expect(deps.dueReads).toBe(1);
  scheduler.stop();
  release?.();
  await starting;
  expect(deps.showAlert).not.toHaveBeenCalled();
  expect(await reminderStore.listActive()).toHaveLength(1);
});

it("弹窗请求在 stop 后才成功，旧生命周期不再发通知或改变宠物状态", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  const { petState } = await import("@/services/pet-state");
  await reminderStore.ready;
  await reminderStore.create("停止后的迟到交付", Date.now() - 1000);
  let release: () => void = () => {};
  deps.showAlert.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const scheduler = new ReminderScheduler();
  const starting = scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.showAlert).toHaveBeenCalledTimes(1);
  scheduler.stop();
  release();
  await starting;
  expect(deps.notify).not.toHaveBeenCalled();
  expect(petState.current).toBe("idle");
});

it("恢复活动事件立即补扫，不必等下次心跳", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  deps.presence.current = "away";
  await reminderStore.create("回来了就提醒", Date.now() - 1000);
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  expect(deps.showAlert).not.toHaveBeenCalled();
  deps.presence.current = "active";
  await emit(STATE_EVENTS.presenceChanged, { presence: "active" });
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.showAlert).toHaveBeenCalledTimes(1);
  scheduler.stop();
});

it("JS 定时器未运行时，原生心跳仍可按绝对时刻触发提醒", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  await reminderStore.create("隐藏窗口也到点", Date.now() + 20_000);
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  // 只改变时钟不推进 setInterval，模拟 WebView 定时器被后台节流。
  vi.setSystemTime(Date.now() + 21_000);
  await emit(STATE_EVENTS.nativeTick);
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.showAlert).toHaveBeenCalledWith(expect.objectContaining({ body: "隐藏窗口也到点" }));
  scheduler.stop();
});

it("弹窗失败且回滚也暂时失败时，下一心跳先恢复认领再重试交付", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  await reminderStore.create("不能被失败吃掉", Date.now() - 1000);
  deps.showAlert.mockRejectedValueOnce(new Error("窗口暂时失败"));
  deps.rollbackFailures = 1;
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  expect(deps.showAlert).toHaveBeenCalledTimes(1);
  expect(deps.notify).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(deps.showAlert).toHaveBeenCalledTimes(2);
  expect(deps.notify).toHaveBeenCalledTimes(1);
  expect(await reminderStore.listActive()).toHaveLength(0);
  scheduler.stop();
});

it("认领 SQL 在途时停止调度，返回后恢复 active 而不弹窗", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  await reminderStore.create("认领中停止", Date.now() - 1000);
  let release: (() => void) | undefined;
  deps.claimBlock = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new ReminderScheduler();
  const starting = scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(await reminderStore.listActive()).toHaveLength(0);
  scheduler.stop();
  release?.();
  await starting;
  expect(await reminderStore.listActive()).toHaveLength(1);
  expect(deps.showAlert).not.toHaveBeenCalled();
});

it("提醒创建落库后广播失败仍返回成功，避免重试造成重复提醒", async () => {
  const { reminderStore } = await import("@/services/reminders");
  await reminderStore.ready;
  mockIPC(cmd => { if (cmd === "plugin:event|emit") throw new Error("事件传输暂时失败"); });
  const reminder = await reminderStore.create("成功写库", Date.now() + 10_000);
  expect(reminder.text).toBe("成功写库");
  expect(await reminderStore.listActive()).toHaveLength(1);
});

it("服务拒绝无法展示的空正文与非法时间，避免创建永远交付失败的提醒", async () => {
  const { reminderStore } = await import("@/services/reminders");
  await reminderStore.ready;
  await expect(reminderStore.create("   ", Date.now() + 1000)).rejects.toThrow("提醒内容不能为空");
  await expect(reminderStore.create("喝水", Infinity)).rejects.toThrow("提醒时间无效");
  expect(await reminderStore.listActive()).toHaveLength(0);
});

it("注册监听失败必须报告启动失败，清理后能重新启动", async () => {
  const { ReminderScheduler } = await import("@/services/reminders");
  mockIPC(cmd => {
    if (cmd === "plugin:event|listen") throw new Error("监听注册暂时失败");
  });
  const scheduler = new ReminderScheduler();
  await expect(scheduler.start()).rejects.toThrow("监听注册暂时失败");
  mockIPC(() => undefined, { shouldMockEvents: true });
  await expect(scheduler.start()).resolves.toBeUndefined();
  scheduler.stop();
});

it("未确认提醒在调度器重建后恢复弹窗，但不重复发送系统通知", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  await reminderStore.create("重启也不能丢", Date.now() - 1000);
  const first = new ReminderScheduler();
  await first.start();
  expect(deps.showAlert).toHaveBeenCalledTimes(1);
  first.stop();
  const restarted = new ReminderScheduler();
  await restarted.start();
  expect(deps.showAlert).toHaveBeenCalledTimes(2);
  expect(deps.notify).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(deps.showAlert).toHaveBeenCalledTimes(2);
  restarted.stop();
});

it("用户确认成功落库后，重建调度器不再恢复这条提醒", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  const reminder = await reminderStore.create("确认后不重弹", Date.now() - 1000);
  const first = new ReminderScheduler();
  await first.start();
  await emit(STATE_EVENTS.appAlertAcked, { kind: "reminder", id: `reminder:${reminder.id}` });
  await vi.advanceTimersByTimeAsync(0);
  const rows = deps.db!.prepare("SELECT acknowledged_at FROM reminders WHERE id = ?").all(reminder.id) as Array<{ acknowledged_at: number | null }>;
  expect(rows[0].acknowledged_at).not.toBeNull();
  first.stop();
  const restarted = new ReminderScheduler();
  await restarted.start();
  expect(deps.showAlert).toHaveBeenCalledTimes(1);
  restarted.stop();
});

it("确认写库临时失败，下一心跳重试且不重放已经确认的弹窗", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  const reminder = await reminderStore.create("确认需要重试", Date.now() - 1000);
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  deps.failWrite = true;
  await emit(STATE_EVENTS.appAlertAcked, { kind: "reminder", id: `reminder:${reminder.id}` });
  await vi.advanceTimersByTimeAsync(0);
  deps.failWrite = false;
  await vi.advanceTimersByTimeAsync(1000);
  scheduler.stop();
  const restarted = new ReminderScheduler();
  await restarted.start();
  expect(deps.showAlert).toHaveBeenCalledTimes(1);
  restarted.stop();
});

it("旧库迁移将历史 fired 视为已确认，active 仍能到点派发", async () => {
  deps.db!.exec(`CREATE TABLE reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, fire_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, fired_at INTEGER
  );
  INSERT INTO reminders(text,fire_at,status,created_at,fired_at) VALUES('旧已通知',1,'fired',1,2);
  INSERT INTO reminders(text,fire_at,status,created_at,fired_at) VALUES('旧待通知',1,'active',1,NULL);`);
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  expect(deps.showAlert).toHaveBeenCalledTimes(1);
  expect(deps.showAlert).toHaveBeenCalledWith(expect.objectContaining({ body: "旧待通知" }));
  const added = await reminderStore.create("迁移后新提醒", Date.now() + 60_000);
  const rows = deps.db!.prepare("SELECT acknowledged_at FROM reminders WHERE id = ?").all(added.id) as Array<{ acknowledged_at: number | null }>;
  expect(rows[0].acknowledged_at).toBeNull();
  scheduler.stop();
});

it("模拟认领后进程中断，fired但未确认的记录仍能在启动恢复", async () => {
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  await reminderStore.ready;
  const reminder = await reminderStore.create("认领不等于用户看到", Date.now() - 1000);
  deps.db!.prepare("UPDATE reminders SET status='fired',fired_at=? WHERE id=?").run(Date.now(), reminder.id);
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  expect(deps.showAlert).toHaveBeenCalledWith(expect.objectContaining({ body: "认领不等于用户看到" }));
  expect(deps.notify).not.toHaveBeenCalled();
  scheduler.stop();
});

it("旧库 ALTER 成功但回填失败后，再次连接仍完成迁移并避免历史轰炸", async () => {
  deps.db!.exec(`CREATE TABLE reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, fire_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, fired_at INTEGER
  ); INSERT INTO reminders(text,fire_at,status,created_at,fired_at) VALUES('历史已通知',1,'fired',1,2);`);
  const { reminderStore, ReminderScheduler } = await import("@/services/reminders");
  deps.migrationFailures = 1;
  await expect(reminderStore.ready).rejects.toThrow("迁移回填临时失败");
  await expect(reminderStore.ready).resolves.toBeUndefined();
  const scheduler = new ReminderScheduler();
  await scheduler.start();
  expect(deps.showAlert).not.toHaveBeenCalled();
  scheduler.stop();
});
