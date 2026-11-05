import { beforeEach, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ load: vi.fn(), execute: vi.fn(), select: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: deps.load } }));
beforeEach(() => {
  vi.resetModules();
  deps.load.mockReset().mockResolvedValue({ execute: deps.execute, select: deps.select });
  deps.execute.mockReset().mockResolvedValue({ rowsAffected: 0 });
  deps.select.mockReset().mockResolvedValue([{ name: "acknowledged_at" }]);
});

it("首次连接失败不会永久毒化连接缓存", async () => {
  const { getDb } = await import("@/services/db");
  deps.load.mockRejectedValueOnce(new Error("临时不可用"));
  await expect(getDb()).rejects.toThrow("临时不可用");
  await expect(getDb()).resolves.toHaveProperty("execute");
  expect(deps.load).toHaveBeenCalledTimes(2);
});

it("建表失败后可重试，成功后的并发调用仍共用一个连接", async () => {
  const { getDb } = await import("@/services/db");
  deps.execute.mockRejectedValueOnce(new Error("临时锁定"));
  await expect(getDb()).rejects.toThrow("临时锁定");
  const [first, second] = await Promise.all([getDb(), getDb()]);
  expect(first).toBe(second);
  expect(deps.load).toHaveBeenCalledTimes(2);
});
