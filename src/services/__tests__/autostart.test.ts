import { describe, expect, it, vi } from "vitest";

// services/autostart 是「设置页 ↔ Rust 自启通道」的薄封装：两个 Tauri 入口在
// Node 环境不存在，按官方 mock 习惯替换即可。本文件只测纯函数 describeAutostart
// （意图 vs 系统真值 → 人话），副作用路径由真机走查覆盖。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));

import { describeAutostart, type AutostartSystemState } from "@/services/autostart";

/**
 * 自启真值回显的判定表（v0.9.1）。
 *
 * 为什么这些分支值得单测：它们直接决定用户看到"已生效"还是"被拦下了"。
 * 判定写错的方向有两种，代价都不对称——
 * - 把失败说成成功：用户以为开了，开机没启动，还会认为软件坏了；
 * - 把成功说成失败：用户白点几次「重新应用」，徒增困惑。
 */
function state(enabled: boolean, ok = true, error?: string): AutostartSystemState {
  return { enabled, ok, error };
}

describe("describeAutostart（意图 + 系统真值 → 提示）", () => {
  it("读不到系统真值时不作判断", () => {
    expect(describeAutostart(true, null)).toEqual({ tone: "none", text: "" });
    expect(describeAutostart(false, null)).toEqual({ tone: "none", text: "" });
  });

  it("想开且系统已登记 → 明确告知已生效", () => {
    const hint = describeAutostart(true, state(true));
    expect(hint.tone).toBe("ok");
    expect(hint.text).toContain("下次开机");
  });

  it("想开、执行称成功但系统里没有 → 警告被拦截并指向「重新应用」", () => {
    // 这就是真实世界最常见的一种：安全软件回滚了注册表写入
    const hint = describeAutostart(true, state(false, true));
    expect(hint.tone).toBe("warn");
    expect(hint.text).toContain("重新应用");
  });

  it("想开但执行失败 → 带上系统原话，方便判断是权限还是拦截", () => {
    const hint = describeAutostart(true, state(false, false, "拒绝访问"));
    expect(hint.tone).toBe("warn");
    expect(hint.text).toContain("拒绝访问");
  });

  it("不想开但系统里还留着启动项 → 提示可清理", () => {
    const hint = describeAutostart(false, state(true));
    expect(hint.tone).toBe("warn");
    expect(hint.text).toContain("重新应用");
  });

  it("不想开且系统也没有 → 安静，不占视线", () => {
    expect(describeAutostart(false, state(false))).toEqual({ tone: "none", text: "" });
  });
});
