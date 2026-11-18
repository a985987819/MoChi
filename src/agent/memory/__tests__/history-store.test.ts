import { beforeEach, expect, it, vi } from "vitest";

/**
 * appendUserDeduped（v0.27.0 会话丢失修复）：用户消息必须落库，重试重发的
 * 相同输入跳过。mock plugin-sql（同 db.test.ts 模式）+ 记录 execute 的 INSERT。
 */

const deps = vi.hoisted(() => ({ load: vi.fn(), execute: vi.fn(), select: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: deps.load } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

beforeEach(() => {
  vi.resetModules();
  deps.load.mockReset().mockResolvedValue({ execute: deps.execute, select: deps.select });
  deps.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  deps.select.mockReset().mockResolvedValue([]);
});

const INSERT_USER = /INSERT INTO messages .*VALUES/;
const lastInsert = () => {
  const calls = deps.execute.mock.calls.filter(([sql]) => INSERT_USER.test(String(sql)));
  return calls[calls.length - 1]?.[1] as unknown[] | undefined;
};

it("末尾不是相同用户消息：正常落库", async () => {
  const { historyStore } = await import("@/agent/memory/history-store");
  deps.select.mockResolvedValue([{ role: "assistant", content: "好的" }]);
  await historyStore.appendUserDeduped("你好");
  expect(lastInsert()?.[1]).toBe("user");
  expect(lastInsert()?.[2]).toBe("你好");
});

it("末尾是相同的用户输入：跳过（重试路径去重）", async () => {
  const { historyStore } = await import("@/agent/memory/history-store");
  deps.select.mockResolvedValue([{ role: "user", content: "你好" }]);
  await historyStore.appendUserDeduped("你好");
  expect(lastInsert()).toBeUndefined();
});

it("空会话：首条用户消息落库", async () => {
  const { historyStore } = await import("@/agent/memory/history-store");
  deps.select.mockResolvedValue([]);
  await historyStore.appendUserDeduped("你好");
  expect(lastInsert()?.[1]).toBe("user");
});
