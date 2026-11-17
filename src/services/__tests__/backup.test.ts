import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "C:/appdata/com.mochi.pet") }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: vi.fn(async () => ({ execute: vi.fn(async () => 0) })) } }));

import { formatBytes } from "@/services/backup";

/**
 * 备份服务（v0.17.0）能自动验证的部分只有人话化换算——zip/覆盖/校验都在
 * Rust 侧（classify_entry / strip_api_keys 的单测见 lib.rs），跨窗口的
 * checkpoint 行为只能真机验证。
 */
describe("formatBytes（备份体积人话化）", () => {
  it("小于 1KB 显示字节", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("KB 区间取整显示", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(20 * 1024 * 1.4)).toBe("28 KB");
  });

  it("MB 区间保留一位小数", () => {
    expect(formatBytes(3.5 * 1024 * 1024)).toBe("3.5 MB");
    expect(formatBytes(48 * 1024 * 1024)).toBe("48.0 MB");
  });

  it("非法输入不渲染出奇怪的数字", () => {
    expect(formatBytes(Number.NaN)).toBe("?");
    expect(formatBytes(-5)).toBe("?");
  });
});
