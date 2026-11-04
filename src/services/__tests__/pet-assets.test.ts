import { beforeEach, expect, it, vi } from "vitest";
const backend = vi.hoisted(() => ({ assets: {} as Record<string, string[]>, failed: false }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => {
    if (backend.failed) throw new Error("素材目录读取失败");
    return backend.assets;
  },
  convertFileSrc: (path: string) => `asset://${path}`,
}));
import { listVariants, parseAssetName } from "@/services/pet-assets";

beforeEach(() => { backend.assets = {}; backend.failed = false; });

it("存在用户素材时不随机穿插内置图", async () => {
  backend.assets = { happy: ["E:/pet-assets/happy.gif"] };
  const variants = await listVariants("happy");
  expect(variants.length).toBe(1);
  expect(variants[0]).toMatchObject({ fromUser: true, animated: true });
});

it("用户目录查询失败仍保留内置素材", async () => {
  backend.failed = true;
  const variants = await listVariants("focus");
  expect(variants.length).toBeGreaterThan(0);
  expect(variants.every(v => !v.fromUser)).toBe(true);
});

it("用户图加载失败后回退内置，内置也失败时返回空池让界面显示占位", async () => {
  backend.assets = { alert: ["E:/pet-assets/alert.png"] };
  const failed = new Set(["asset://E:/pet-assets/alert.png"]);
  const bundled = await listVariants("alert", failed);
  expect(bundled.length).toBeGreaterThan(0);
  expect(bundled.every(v => !v.fromUser)).toBe(true);
  bundled.forEach(v => failed.add(v.url));
  expect(await listVariants("alert", failed)).toEqual([]);
});

it("文件名只剥离数字变体后缀，统一大小写与 jpeg", () => {
  expect(parseAssetName("Happy_2.JPEG")).toEqual({ state: "happy", ext: "jpg" });
  expect(parseAssetName("my_state_3.webp")).toEqual({ state: "my_state", ext: "webp" });
  expect(parseAssetName("focus.txt")).toBeNull();
});
