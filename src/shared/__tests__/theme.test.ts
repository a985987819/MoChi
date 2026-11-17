import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveTheme } from "@/shared/theme";
import { normalize } from "@/services/settings";

describe("resolveTheme（模式 → 实际主题）", () => {
  it("显式 light/dark 不看系统", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("system 跟随系统偏好", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("非法值回落 system（normalize 是另一道防线，这里兜广播/手改路径）", () => {
    expect(resolveTheme("neon", false)).toBe("light");
    expect(resolveTheme(undefined, true)).toBe("dark");
  });
});

describe("normalize 的 themeMode 白名单", () => {
  it("合法值原样保留，脏值回落 system", () => {
    expect(normalize({ themeMode: "dark" }).themeMode).toBe("dark");
    expect(normalize({ themeMode: "neon" }).themeMode).toBe("system");
    expect(normalize({}).themeMode).toBe("system");
  });
});

/**
 * 对比度验收（P2-03A 的核心自动化）：从 theme.css **解析真实令牌值**计算
 * WCAG 对比度——令牌改了而测试没改，这里会红。阈值分层：
 * - 正文/强调文字 ≥ 4.5（任务单验收标准，浅深两套都要过）；
 * - 元数据（时间戳/占位符）≥ 3（WCAG 大字/次要信息档，浅色刻意维持原设计层次）。
 */

interface Palette {
  [token: string]: string;
}

function parseBlock(css: string, selector: string): Palette {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`theme.css 缺少 ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);
  const palette: Palette = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
    palette[m[1]] = m[2].trim();
  }
  return palette;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (h.length !== 6) throw new Error(`对比度测试只支持 6 位 hex，收到 ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 对比度（颜色都用 6 位 hex 形式书写，见 theme.css 约定） */
function contrast(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const css = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
const light = parseBlock(css, ":root");
const dark = parseBlock(css, ':root[data-theme="dark"]');

/** 正文与强调文字档：两套主题都必须 ≥ 4.5（前景, 背景成对） */
const BODY_PAIRS: Array<[string, string]> = [
  ["text-strong", "bg-surface"],
  ["text", "bg-surface"],
  ["text-muted", "bg-surface"],
  ["text", "bg-window"],
  ["accent-text", "bg-surface"],
  ["accent-text", "bg-accent-soft"],
  ["success-text", "bg-success-tint"],
  ["success-text", "bg-surface"],
  ["info-text", "bg-info-tint"],
  ["warn-text", "bg-warn-tint"],
  ["text-bubble", "bg-warn-tint"],
  ["accent-text", "bg-window"],
];

/** 元数据档：≥ 3（时间戳/占位符——次要信息，浅色维持原设计层次） */
const METADATA_PAIRS: Array<[string, string]> = [
  ["text-faint", "bg-surface"],
  ["text-faint", "bg-window"],
  ["text-faint2", "bg-surface"],
];

describe.each([
  ["浅色", light],
  ["深色", dark],
])("theme.css %s对比度", (_name, palette) => {
  it.each(BODY_PAIRS)("正文 %s on %s ≥ 4.5", (fg, bg) => {
    expect(palette[fg]).toBeDefined();
    expect(palette[bg]).toBeDefined();
    expect(contrast(palette[fg], palette[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(METADATA_PAIRS)("元数据 %s on %s ≥ 3", (fg, bg) => {
    expect(contrast(palette[fg], palette[bg])).toBeGreaterThanOrEqual(3);
  });
});

it("深色窗底比浅色窗底暗（暖棕灰的成立前提）", () => {
  expect(luminance(dark["bg-window"])).toBeLessThan(luminance(light["bg-window"]));
});
