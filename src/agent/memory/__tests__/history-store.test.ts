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

it("首条用户消息自动把占位标题改成内容摘要", async () => {
  const { historyStore } = await import("@/agent/memory/history-store");
  deps.select.mockImplementation(async (sql: string) => {
    if (String(sql).includes("COUNT(*)")) return [{ n: 0 }];
    return [];
  });
  await historyStore.appendUserDeduped("帮我记住明天九点开周会，别忘了带电脑");
  const titleUpdate = deps.execute.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE sessions SET title"));
  expect(titleUpdate).toBeDefined();
  const title = titleUpdate?.[1] as unknown[] | undefined;
  expect(String(title?.[0])).toContain("帮我记住明天九点开周会");
  expect(String(title?.[0]).length).toBeLessThanOrEqual(25); // 24 字 + 省略号
});

it("listSessions 把消息活动时间映射为 updatedAt 并按行返回", async () => {
  const { historyStore } = await import("@/agent/memory/history-store");
  deps.select.mockResolvedValue([
    { id: "s2", title: "第二个会话", created_at: 100, updated_at: 300 },
    { id: "s1", title: "第一个会话", created_at: 100, updated_at: 200 },
  ]);
  const list = await historyStore.listSessions();
  expect(list).toEqual([
    { id: "s2", title: "第二个会话", createdAt: 100, updatedAt: 300 },
    { id: "s1", title: "第一个会话", createdAt: 100, updatedAt: 200 },
  ]);
});

it("createSession 切到新会话；setCurrentSession 拒绝不存在的 id", async () => {
  const { historyStore } = await import("@/agent/memory/history-store");
  const created = await historyStore.createSession("测试会话");
  expect(await historyStore.getCurrentSessionId()).toBe(created.id);

  deps.select.mockResolvedValue([]);
  await expect(historyStore.setCurrentSession("missing")).rejects.toThrow("会话不存在");
});
