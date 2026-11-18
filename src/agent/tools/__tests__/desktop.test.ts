import { describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ openUrl: vi.fn(), revealItemInDir: vi.fn(), appDataDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: deps.openUrl, revealItemInDir: deps.revealItemInDir }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: deps.appDataDir }));

import { openDataFolderTool, openUrlTool, validateHttpUrl } from "@/agent/tools/desktop";

/**
 * 桌面操作工具（v0.28.0）——open_url 的 scheme 白名单是安全边界（file:///内网
 * 协议拒绝），必须单测钉死；open_data_folder 的回执文案结构一并覆盖。
 */

describe("validateHttpUrl（scheme 白名单）", () => {
  it("http/https 放行并 trim", () => {
    expect(validateHttpUrl("https://platform.deepseek.com")).toBe("https://platform.deepseek.com");
    expect(validateHttpUrl("  http://localhost:11434  ")).toBe("http://localhost:11434");
  });

  it("危险协议一律拒绝", () => {
    expect(validateHttpUrl("file:///C:/Windows/System32")).toBeNull();
    expect(validateHttpUrl("javascript:alert(1)")).toBeNull();
    expect(validateHttpUrl("data:text/html,<script>")).toBeNull();
    expect(validateHttpUrl("ftp://example.com")).toBeNull();
  });

  it("非字符串形态/空值拒绝", () => {
    expect(validateHttpUrl("")).toBeNull();
    expect(validateHttpUrl("不是网址")).toBeNull();
  });
});

describe("open_url / open_data_folder", () => {
  it("open_url 合法网址调 opener 并返回成功", async () => {
    deps.openUrl.mockResolvedValue(undefined);
    const tool = openUrlTool();
    const result = await tool.execute({ url: "https://platform.deepseek.com" }, {} as never);
    expect(result.ok).toBe(true);
    expect(deps.openUrl).toHaveBeenCalledWith("https://platform.deepseek.com");
  });

  it("open_url 非 http 协议拒绝且不触发 opener", async () => {
    deps.openUrl.mockClear();
    const tool = openUrlTool();
    const result = await tool.execute({ url: "file:///etc/passwd" }, {} as never);
    expect(result.ok).toBe(false);
    expect(deps.openUrl).not.toHaveBeenCalled();
  });

  it("open_url opener 抛错转为 ok:false（不炸 agent 循环）", async () => {
    deps.openUrl.mockRejectedValue(new Error("no browser"));
    const tool = openUrlTool();
    const result = await tool.execute({ url: "https://example.com" }, {} as never);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("浏览器打开失败");
  });

  it("open_data_folder 调 revealItemInDir 并返回目录", async () => {
    deps.appDataDir.mockResolvedValue("C:/appdata/com.mochi.pet");
    deps.revealItemInDir.mockResolvedValue(undefined);
    const tool = openDataFolderTool();
    const result = await tool.execute({} as never, {} as never);
    expect(result.ok).toBe(true);
    expect(deps.revealItemInDir).toHaveBeenCalledWith("C:/appdata/com.mochi.pet");
  });
});
