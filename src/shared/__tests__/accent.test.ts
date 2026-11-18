import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  DEFAULT_ACCENT,
  deriveAccentTokens,
  hexToHsl,
  hslToHex,
} from "@/shared/accent";

/**
 * 主题色派生（v0.26.0）——核心保证：**任意**用户选色派生出的文字档，
 * 对各自的背景对比度 ≥4.5（浅/深两套）。默认粉色不走派生（theme.css 手调值），
 * 但派生函数对它也必须给出达标结果（用户改回近似色时同一保证成立）。
 */

const LIGHT_SURFACE = "#ffffff";
const DARK_SURFACE = "#332c30";

describe("HSL 换算", () => {
  it("hexToHsl ↔ hslToHex 往返一致", () => {
    for (const hex of ["#ff8fab", "#b3455a", "#332c30", "#ffffff", "#000000", "#9ec3ff"]) {
      const [h, s, l] = hexToHsl(hex);
      expect(hslToHex(h, s, l)).toBe(hex);
    }
  });

  it("灰色的色相与饱和度归零", () => {
    const [h, s] = hexToHsl("#808080");
    expect(s).toBe(0);
    expect(h).toBe(0);
  });
});

describe("deriveAccentTokens：文字档对比度保证（浅色主题）", () => {
  const cases: Array<[string, string]> = [
    ["默认粉", DEFAULT_ACCENT],
    ["红", "#ff4d4d"],
    ["橙", "#ffab7e"],
    ["黄（最难达标的色相）", "#ffff00"],
    ["绿", "#4dc26b"],
    ["蓝", "#4d8cff"],
    ["紫", "#b3a3ff"],
    ["近白（明度上限钳制）", "#fdfdfd"],
    ["近黑（明度下限钳制）", "#0a0a0a"],
    ["灰（低饱和）", "#999999"],
  ];
  it.each(cases)("%s → accent-text 对白底 ≥4.5", (_name, base) => {
    const tokens = deriveAccentTokens(base, false);
    expect(contrastRatio(tokens["accent-text"]!, LIGHT_SURFACE)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(cases)("%s → accent-fill 明度被钳制（白字不至于完全看不见）", (_name, base) => {
    const tokens = deriveAccentTokens(base, false);
    expect(contrastRatio(tokens["accent-fill"]!, "#ffffff")).toBeGreaterThanOrEqual(2);
  });
});

describe("deriveAccentTokens：文字档对比度保证（深色主题）", () => {
  const cases: Array<[string, string]> = [
    ["默认粉", DEFAULT_ACCENT],
    ["红", "#ff4d4d"],
    ["黄", "#ffff00"],
    ["蓝", "#4d8cff"],
    ["近白", "#fdfdfd"],
    ["近黑", "#0a0a0a"],
    ["灰", "#999999"],
  ];
  it.each(cases)("%s → accent-text 对深色卡底 ≥4.5", (_name, base) => {
    const tokens = deriveAccentTokens(base, true);
    expect(contrastRatio(tokens["accent-text"]!, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("派生的色相保持与结构", () => {
  it("默认粉派生的 text 档保留色相（±2°）", () => {
    const [h0] = hexToHsl(DEFAULT_ACCENT);
    for (const dark of [false, true]) {
      const tokens = deriveAccentTokens(DEFAULT_ACCENT, dark);
      const [h1] = hexToHsl(tokens["accent-text"]!);
      expect(Math.abs(h1 - h0)).toBeLessThan(2);
    }
  });

  it("派生结果包含全部 accent 令牌且为合法 hex", () => {
    for (const dark of [false, true]) {
      const tokens = deriveAccentTokens(DEFAULT_ACCENT, dark);
      for (const [, value] of Object.entries(tokens)) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});
