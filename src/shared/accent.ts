/**
 * 主题色派生（v0.26.0）—— 一个基准色驱动全站粉色系令牌。
 *
 * # 派生而非手调
 *
 * 用户用调色盘无级选色，不可能为每种颜色手写令牌——从基准色的 HSL 出发
 * **派生** accent 家族：文字档用亮度搜索保证 WCAG ≥4.5，底纹档按明暗主题
 * 各给一组明度。默认粉色（#ff8fab）**不走派生**：theme.css 的手调值直接生效
 * （派生函数对任意色可用，但手调的默认值更精致，二者不该互相顶掉）。
 *
 * # 派生的令牌
 *
 * accent-fill（白字色块）/ accent-text（浅底粉字）/ accent-muted /
 * bg-accent-soft / bg-accent-tint / border-accent / ring-accent——
 * 中性底色（奶油底/卡片/边框）与文字灰阶**不在派生范围**：它们是"纸"，
 * 主题色是"糖霜"，换糖霜不换纸。
 */

import { loadSettings, DEFAULT_ACCENT } from "@/services/settings";

// 供设置页引用（单一事实源在 settings.ts，避免两处默认色漂移）
export { DEFAULT_ACCENT };

/** 会被派生覆盖的令牌（theme.css 里同名的静态值是默认态） */
export const ACCENT_TOKENS = [
  "accent-fill",
  "accent-text",
  "accent-muted",
  "bg-accent-soft",
  "bg-accent-tint",
  "border-accent",
  "ring-accent",
] as const;

export type AccentTokens = Partial<Record<(typeof ACCENT_TOKENS)[number], string>>;

/** 派生结果的深色表面（深色主题卡片底 #332c30）——文字对比度以它为背景计算 */
const DARK_SURFACE = "#332c30";

/** hex → [h(0-360), s(0-100), l(0-100)]（HSL，六位 hex 才合法） */
export function hexToHsl(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (h.length !== 6) throw new Error(`hexToHsl 需要六位 hex: ${hex}`);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hue: number;
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) hue = ((b - r) / d + 2) / 6;
  else hue = ((r - g) / d + 4) / 6;
  return [hue * 360, s * 100, l * 100];
}

/** [h, s, l] → 六位 hex（标准 HSL → RGB 算法） */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const lig = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  const seg = Math.floor(hue / 60) % 6;
  const rgb: Array<[number, number, number]> = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = rgb[seg];
  const to255 = (v: number) => Math.round((v + m) * 255);
  return `#${[to255(r), to255(g), to255(b)].map(v => v.toString(16).padStart(2, "0")).join("")}`;
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 相对亮度（WCAG） */
export function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  return 0.2126 * linear(parseInt(h.slice(0, 2), 16)) + 0.7152 * linear(parseInt(h.slice(2, 4), 16)) + 0.0722 * linear(parseInt(h.slice(4, 6), 16));
}

/** WCAG 对比度（两色都须为六位 hex） */
export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * 在固定色相/饱和度下扫描明度，找第一个对 bg 对比度 ≥ target 的值。
 * from → to 逐 1% 步进；到端点仍不达标就返回端点（最接近达标的方向）。
 */
function searchLightness(h: number, s: number, from: number, to: number, bg: string, target: number): number {
  const step = from <= to ? 1 : -1;
  let current = from;
  for (;;) {
    if (contrastRatio(hslToHex(h, s, current), bg) >= target) return current;
    if (current === to) return current;
    current += step;
    if (current < 0 || current > 100) return Math.min(100, Math.max(0, current));
  }
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * 从基准色派生整套 accent 令牌（纯函数，单测覆盖对比度下限）。
 *
 * - fill = 基准色（明度夹到 40~78%，避免用户选近白/近黑时白字彻底看不见）；
 * - text：浅色主题向**暗**搜索 ≥4.5（白底），深色主题向**亮**搜索（深底）；
 * - soft/tint/border：同色相不同明度的底纹与边框；
 * - muted：低饱和版（次要信息的粉灰）。
 */
export function deriveAccentTokens(base: string, dark: boolean): AccentTokens {
  let [h, s, l] = hexToHsl(base);
  s = clamp(s, 30, 100); // 全灰（s≈0）派生出的是灰阶——允许，但下限保底避免脏色
  l = clamp(l, 40, 80);

  if (dark) {
    const textL = searchLightness(h, s, Math.max(l, 60), 92, DARK_SURFACE, 4.5);
    return {
      "accent-fill": hslToHex(h, s, l),
      "accent-text": hslToHex(h, s, textL),
      "accent-muted": hslToHex(h, s * 0.55, 52),
      "bg-accent-soft": hslToHex(h, s * 0.85, 23),
      "bg-accent-tint": hslToHex(h, s * 0.85, 21),
      "border-accent": hslToHex(h, s * 0.9, 31),
      "ring-accent": hslToHex(h, s, 60),
    };
  }

  // fill：向**暗**搜索对白字 ≥2（近白/高明度的用户选色会被压暗，保证白字可见）
  const fillL = searchLightness(h, s, Math.min(l, 66), 25, "#ffffff", 2);
  const textL = searchLightness(h, s, Math.min(l, 55), 15, "#ffffff", 4.5);
  return {
    "accent-fill": hslToHex(h, s, fillL),
    "accent-text": hslToHex(h, s, textL),
    "accent-muted": hslToHex(h, s * 0.55, 74),
    "bg-accent-soft": hslToHex(h, s * 0.9, 96),
    "bg-accent-tint": hslToHex(h, s * 0.9, 94),
    "border-accent": hslToHex(h, s * 0.9, 88),
    "ring-accent": hslToHex(h, s, 78),
  };
}

/** 派生令牌写到 documentElement 的内联样式——覆盖 theme.css 静态值（默认色时移除还原） */
export function applyAccentColor(color: string | undefined, dark: boolean): void {
  if (typeof document === "undefined") return; // node 环境/异常态：静默
  const root = document.documentElement;
  const normalized = color?.toLowerCase();
  const useDefault = !normalized || normalized === DEFAULT_ACCENT;
  const tokens = useDefault ? {} : deriveAccentTokens(normalized, dark);
  for (const token of ACCENT_TOKENS) {
    const value = tokens[token];
    if (value) root.style.setProperty(`--${token}`, value);
    else root.style.removeProperty(`--${token}`);
  }
}

/**
 * 读取当前主题色并应用（各窗口的 installThemeWatcher 在主题/语言刷新时一并调用）。
 * 设置读取失败保持现状——主题色是外观，不该报错打断功能。
 */
export async function refreshAccentFromSettings(dark: boolean): Promise<void> {
  try {
    const settings = await loadSettings();
    applyAccentColor(settings.accentColor, dark);
  } catch {
    // 静默：同 installThemeWatcher 的取舍
  }
}
