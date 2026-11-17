/**
 * 主题应用（P2-03A / v0.18.0）—— 设置里的主题模式 → 每个 WebView 的 data-theme。
 *
 * # 为什么每个窗口自己装
 *
 * 三个 WebView 各是一份 DOM，CSS 变量挂在各自的 documentElement 上——主题必须
 * 在每个窗口分别应用（跨窗口没有"共享 DOM"）。installThemeWatcher 在每个窗口
 * 入口调用一次：读初始设置 + 订阅 settingsChanged + 订阅系统深浅变化
 * （"跟随系统"模式下系统切换要即时生效，不能等下次设置变更）。
 *
 * # 收方校验
 *
 * settingsChanged 广播不带可信类型（learning/08 §2 的经验），这里每次重读完整
 * 设置再应用，而不是从事件载荷里取增量——多一个请求，少一类漂移。
 */

import { listen } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";
import { loadSettings } from "@/services/settings";

/** 模式 → 实际主题："system" 由系统偏好决定；非法值回落 system */
export function resolveTheme(mode: string | undefined, systemPrefersDark: boolean): "light" | "dark" {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return systemPrefersDark ? "dark" : "light";
}

/** 把解析结果写进本窗口的 documentElement（CSS 变量据此切换） */
export function applyResolvedTheme(theme: "light" | "dark"): void {
  const root = document.documentElement;
  if (theme === "dark") {
    root.dataset.theme = "dark";
  } else {
    // 浅色要显式移除：data-theme="light" 会让 CSS 里以 dark 分支为准的选择器歧义
    delete root.dataset.theme;
  }
}

/**
 * 在本窗口安装主题监听（每个 WebView 入口调用一次）。返回清理函数（HMR 用）。
 * matchMedia 只在"跟随系统"时有意义，但订阅常开成本为零——切换瞬间重算即可。
 */
export function installThemeWatcher(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const refresh = () => {
    void loadSettings()
      .then(settings => applyResolvedTheme(resolveTheme(settings.themeMode, media.matches)))
      .catch(() => undefined); // 读不到设置保持现状——主题是外观，不该报错打断功能
  };
  refresh();
  media.addEventListener("change", refresh);
  let offSettings: (() => void) | undefined;
  void listen(STATE_EVENTS.settingsChanged, refresh).then(off => {
    offSettings = off;
  });
  return () => {
    media.removeEventListener("change", refresh);
    offSettings?.();
  };
}
