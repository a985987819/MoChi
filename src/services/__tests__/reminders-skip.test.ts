import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 周期提醒治理（v0.20.0）的 Store 层语义：skipNext / cancelSeries。
 *
 * 调度器的"静默交付"分支依赖真实心跳与窗口，难以单测；但**正确性的核心在
 * SQL 谓词**——跳过必须同时满足「active + repeat != none + 未标记过」，取消
 * 整串必须逐行条件更新（部分被认领时如实返回子集）。
 *
 * mock 策略：getDb 的建表 DDL / PRAGMA 也会经过 execute——断言一律**按 SQL
 * 片段过滤**，绝不断言"execute 从未被调用"；rowsAffected 用实现注入，让
 * DDL 走默认 1、被测 UPDATE 走测试指定的值。
 */

const deps = vi.hoisted(() => ({
  load: vi.fn(),
  execute: vi.fn(),
  select: vi.fn(),
  emit: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: deps.load } }));
vi.mock("@tauri-apps/api/event", () => ({ emit: deps.emit, listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const SKIP_SQL = "SET skip = 1";
const CANCEL_SQL = "status = 'cancelled'";
const callsTo = (sqlPart: string) =>
  deps.execute.mock.calls.filter(([sql]) => String(sql).includes(sqlPart));

beforeEach(() => {
  vi.resetModules();
  deps.load.mockReset().mockResolvedValue({ execute: deps.execute, select: deps.select });
  // 默认全部成功：建表 DDL / PRAGMA / 被测 UPDATE 都拿 rowsAffected=1；
  // 需要失败的用例在用例内用 mockImplementation 覆盖。
  deps.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  deps.select.mockReset().mockResolvedValue([]);
  deps.emit.mockReset().mockResolvedValue(undefined);
});

const row = (id: number, overrides: Partial<Record<string, unknown>> = {}) => ({
  id,
  text: `提醒 ${id}`,
  fire_at: 100 + id,
  status: "active",
  created_at: 1,
  fired_at: null,
  acknowledged_at: null,
  repeat: "daily",
  series_id: "s1",
  batch_id: null,
  skip: 0,
  ...overrides,
});

describe("skipNext（跳过一次）", () => {
  it("周期行：置 skip=1，返回值带 skip 标记，并广播", async () => {
    const { reminderStore } = await import("@/services/reminders");
    deps.select.mockResolvedValue([row(7)]);
    const result = await reminderStore.skipNext(7);
    expect(result?.skip).toBe(true);
    const updates = callsTo(SKIP_SQL);
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual([7]);
    expect(deps.emit).toHaveBeenCalled();
  });

  it("一次性提醒不可跳过（跳过=取消，引导走 cancel）", async () => {
    const { reminderStore } = await import("@/services/reminders");
    deps.select.mockResolvedValue([]);
    const result = await reminderStore.skipNext(3);
    expect(result).toBeNull();
    expect(callsTo(SKIP_SQL)).toHaveLength(0);
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it("已标记过（skip=1）的行不可重复置位", async () => {
    const { reminderStore } = await import("@/services/reminders");
    deps.select.mockResolvedValue([]);
    await expect(reminderStore.skipNext(7)).resolves.toBeNull();
    expect(callsTo(SKIP_SQL)).toHaveLength(0);
  });

  it("写入被并发认领（rowsAffected 0）时不广播", async () => {
    const { reminderStore } = await import("@/services/reminders");
    deps.select.mockResolvedValue([row(7)]);
    deps.execute.mockImplementation(async (sql: string) =>
      String(sql).includes(SKIP_SQL) ? { rowsAffected: 0 } : { rowsAffected: 1 },
    );
    await reminderStore.skipNext(7);
    expect(deps.emit).not.toHaveBeenCalled();
  });
});

describe("cancelSeries（取消整串）", () => {
  it("按 series_id 逐行条件取消，只计入 rowsAffected=1 的行", async () => {
    const { reminderStore } = await import("@/services/reminders");
    deps.select.mockResolvedValue([row(1), row(2)]);
    // id=1 取消成功；id=2 恰好被调度器认领（条件更新 0 行）
    deps.execute.mockImplementation(async (sql: string, params?: unknown[]) => ({
      rowsAffected: String(sql).includes(CANCEL_SQL) && (params as number[])?.[0] === 2 ? 0 : 1,
    }));
    const cancelled = await reminderStore.cancelSeries("s1");
    expect(cancelled.map(r => r.id)).toEqual([1]);
    const updates = callsTo(CANCEL_SQL).map(([, params]) => (params as number[])?.[0]);
    expect(updates).toEqual([1, 2]);
    expect(deps.emit).toHaveBeenCalledTimes(1);
  });

  it("串里没有 active 行时返回空且不广播", async () => {
    const { reminderStore } = await import("@/services/reminders");
    deps.select.mockResolvedValue([]);
    await expect(reminderStore.cancelSeries("s1")).resolves.toEqual([]);
    expect(callsTo(CANCEL_SQL)).toHaveLength(0);
    expect(deps.emit).not.toHaveBeenCalled();
  });
});
