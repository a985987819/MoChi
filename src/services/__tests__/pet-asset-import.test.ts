import { describe, expect, it, vi } from "vitest";

// 纯函数测试不触碰 Tauri：invoke 只在 savePetAsset/listUserAssets 里调用，
// 按项目既有习惯 mock 掉，避免 node 环境缺少 IPC 桥。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));

import {
  extOfFileName,
  guessStateFromFileName,
  targetFileName,
} from "@/services/pet-asset-import";

/**
 * 素材导入的两条纯逻辑（v0.9.2）：
 * ① 从文件名猜状态——猜错会让图落到错误状态，宁可返回 null 让用户手选；
 * ② 英文命名规划——必须与 Rust `next_asset_file_name` 同算法，否则预览名与真实名不一致。
 */
describe("guessStateFromFileName（中文/英文文件名 → 状态代码）", () => {
  it("英文规范名直接命中", () => {
    expect(guessStateFromFileName("happy.png")).toBe("happy");
    expect(guessStateFromFileName("focus_2.gif")).toBe("focus");
    expect(guessStateFromFileName("SLEEP.webp")).toBe("sleep");
  });

  it("中文别名命中", () => {
    expect(guessStateFromFileName("开心.png")).toBe("happy");
    expect(guessStateFromFileName("难过_2.jpg")).toBe("sad");
    expect(guessStateFromFileName("伸懒腰.gif")).toBe("stretch");
    expect(guessStateFromFileName("待机.png")).toBe("idle");
  });

  it("带修饰词的常见命名也能认出来", () => {
    expect(guessStateFromFileName("我的开心表情.png")).toBe("happy");
    expect(guessStateFromFileName("开心 (1).png")).toBe("happy");
    expect(guessStateFromFileName("思考-副本.png")).toBe("thinking");
  });

  it("认不出就返回 null，交给用户手选（不瞎猜）", () => {
    expect(guessStateFromFileName("IMG_20261117_203355.png")).toBeNull();
    expect(guessStateFromFileName("截图 2026-11-17 203355.png")).toBeNull();
    expect(guessStateFromFileName("")).toBeNull();
  });
});

describe("extOfFileName（扩展名归一 + 白名单）", () => {
  it("大小写不敏感，jpeg 归一为 jpg", () => {
    expect(extOfFileName("a.PNG")).toBe("png");
    expect(extOfFileName("b.JpEg")).toBe("jpg");
    expect(extOfFileName("c.webp")).toBe("webp");
  });

  it("不支持的格式返回 null（导入前就拦住，避免写完才发现不认识）", () => {
    expect(extOfFileName("a.txt")).toBeNull();
    expect(extOfFileName("a.psd")).toBeNull();
    expect(extOfFileName("noext")).toBeNull();
  });
});

describe("targetFileName（英文命名 + 变体序号）", () => {
  it("没占用就用基础名", () => {
    expect(targetFileName("happy", "png", [])).toBe("happy.png");
  });

  it("被占用则递增 _2、_3（绝不覆盖用户已有素材）", () => {
    expect(targetFileName("happy", "png", ["happy.png"])).toBe("happy_2.png");
    expect(targetFileName("happy", "png", ["happy.png", "happy_2.png"])).toBe("happy_3.png");
  });

  it("同批导入的多张同状态图不互相抢名", () => {
    expect(targetFileName("idle", "png", ["idle.png"], ["idle_2.png"])).toBe("idle_3.png");
  });

  it("不同扩展名各算各的；比较不区分大小写", () => {
    expect(targetFileName("happy", "gif", ["happy.png"])).toBe("happy.gif");
    expect(targetFileName("happy", "png", ["HAPPY.PNG"])).toBe("happy_2.png");
  });
});
