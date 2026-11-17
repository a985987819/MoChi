import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

import { installGlobalErrorLogging, redact } from "@/services/log";

/**
 * 脱敏（P2-01 / v0.16.0）——日志的隐私红线是唯一能自动验证的部分（任务单）。
 * Key 形态必须打码、正常文本必须原样、超长必须截断；与 Rust 侧 redact_message
 * 是同一套规则的两道防线（前端脱敏后上报，Rust 再兜一次底）。
 */
describe("redact（日志脱敏）", () => {
  it("sk- 形态密钥被打码", () => {
    expect(redact("sk-abcdefghijklmnop1234")).toBe("sk-***");
    expect(redact("请求失败 key=sk-abc123XYZ_-9x 重试")).toBe("请求失败 key=sk-*** 重试");
  });

  it("短前缀与普通词汇不误伤（词边界）", () => {
    expect(redact("task-skill-1 完成了")).toBe("task-skill-1 完成了");
    expect(redact("sk-1 太短不算密钥")).toBe("sk-1 太短不算密钥");
  });

  it("Bearer 令牌被打码（大小写不敏感）", () => {
    expect(redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9")).toBe("Authorization: Bearer ***");
    expect(redact("bearer eyJhbGciOiJIUzI1NiJ9")).toBe("Bearer ***");
  });

  it("正常文本原样不变", () => {
    expect(redact("数据库连接失败: SQLITE_BUSY")).toBe("数据库连接失败: SQLITE_BUSY");
    expect(redact("")).toBe("");
  });

  it("超长文本按 800 字符截断并留提示", () => {
    const out = redact("啊".repeat(2000));
    expect(out.length).toBeLessThan(830);
    expect(out.startsWith("啊".repeat(800))).toBe(true);
    expect(out.endsWith("…（截断）")).toBe(true);
  });

  it("打码与截断同时成立（密钥藏在超长消息里：先打码后截断，密钥在截断点之前）", () => {
    const out = redact(`sk-abcdefghijklmnopqrstuvwxyz ${"x".repeat(900)}`);
    expect(out).toContain("sk-***");
    expect(out.endsWith("…（截断）")).toBe(true);
    // 密钥在截断点之后的会被截掉——这是截断的本义（那部分内容没进日志）
    const buried = redact(`${"x".repeat(900)} sk-abcdefghijklmnopqrstuvwxyz`);
    expect(buried).not.toContain("sk-***");
  });
});

describe("installGlobalErrorLogging（全局兜底）", () => {
  it("注册 error 与 unhandledrejection 监听，触发时上报打码后的消息", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const calls: Array<{ level: string; scope: string; message: string }> = [];
    vi.mocked(invoke).mockImplementation(async (_cmd, args) => {
      calls.push(args as { level: string; scope: string; message: string });
      return null;
    });

    // vitest 是 node 环境（没有 window）：stub 一个记录型 window，
    // 直接捕获安装的监听器并手动触发（不依赖真实 DOM 事件流）
    const listeners = new Map<string, (event: unknown) => void>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      },
    });
    try {
      installGlobalErrorLogging("test-window");
      expect(listeners.has("error")).toBe(true);
      expect(listeners.has("unhandledrejection")).toBe(true);

      listeners.get("error")?.({ message: "boom sk-secretvalue123" });
      listeners.get("unhandledrejection")?.({ reason: "rejected hard" });

      await Promise.resolve();
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({ level: "error", scope: "test-window", message: "未捕获异常: boom sk-***" });
      expect(calls[1]).toEqual({ level: "error", scope: "test-window", message: "未处理的 Promise 拒绝: rejected hard" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
