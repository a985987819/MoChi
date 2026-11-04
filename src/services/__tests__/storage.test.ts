// @ts-expect-error Node 22 内置测试驱动；项目未安装 @types/node，生产代码不依赖它。
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
  notify: vi.fn(),
  failWrite: false,
  notificationsEnabled: true,
}));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: async () => ({
  execute: async (sql: string, args: unknown[] = []) => {
    if (deps.failWrite) throw new Error("模拟写入失败");
    const result = deps.db!.prepare(sql.replace(/\$\d+/g, "?")).run(...args);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  },
  select: async (sql: string, args: unknown[] = []) => deps.db!.prepare(sql.replace(/\$\d+/g, "?")).all(...args),
}) } }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => null }) }));
vi.mock("@/services/settings", () => ({ loadSettings: async () => ({ notificationsEnabled: deps.notificationsEnabled }) }));
vi.mock("@/services/presence", () => ({ presenceService: deps.presence }));
vi.mock("@/services/notifications", () => ({ notify: deps.notify }));

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
  deps.notify.mockClear();
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
