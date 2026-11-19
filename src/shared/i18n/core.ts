/**
 * i18n 内核（P2-03B / v0.19.0）—— 刻意不用 i18next。
 *
 * # 为什么手写（任务单：先用简单函数）
 *
 * 需求全集 = 两个字典 + {name} 插值 + 运行时切换 + 跟随系统检测。
 * i18next 的 ICU 复数/上下文/命名空间在这个产品里用不上（中文无复数，
 * 文案总量 ~80 条），引它是为不需要的功能付包体与心智。
 *
 * # 状态模型
 *
 * 模块级 currentLocale + 订阅者集合（React 侧经 useSyncExternalStore 消费）。
 * 每个 WebView 各一份实例——语言来自各自的设置读取（settingsChanged 时重读），
 * 与主题（shared/theme.ts）同一个模式：跨窗口没有共享状态，只有共享的设置事实源。
 */

import { zhCN, type MessageKey } from "./zh-CN";
import { en } from "./en";
import { listen } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";
import { loadSettings } from "@/services/settings";
import { DEFAULT_ADDRESSING } from "@/shared/addressing";

export type Locale = "zh-CN" | "en";

const dictionaries: Record<Locale, Readonly<Record<MessageKey, string>>> = {
  "zh-CN": zhCN,
  en,
};

let currentLocale: Locale = "zh-CN";
/**
 * 当前窗口的宠物自称（v0.29.2）。由 installLocaleWatcher 从 settings 同步；
 * 所有含 `{pet}` 的文案由 t() 自动替换——调用方不需要逐处传名字。
 */
let currentPetName: string = DEFAULT_ADDRESSING.petSelfName;
/** 订阅序号：语言与自称任一变化都 +1，React 直接用整数做快照 */
let revision = 0;
const listeners = new Set<() => void>();

function notify(): void {
  revision += 1;
  for (const fn of listeners) fn();
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  notify();
}

/** 当前宠物自称（供非 i18n 文案如错误提示复用；空值回落默认） */
export function getPetSelfName(): string {
  return currentPetName;
}

/** 更新宠物自称：空白串回落默认值，与 settings 的 normalize 语义一致 */
export function setPetSelfName(name: string): void {
  const next = name.trim() || DEFAULT_ADDRESSING.petSelfName;
  if (next === currentPetName) return;
  currentPetName = next;
  notify();
}

export function getRevision(): number {
  return revision;
}

/** React useSyncExternalStore 的订阅接口（语言或自称变化都会通知） */
export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 翻译 + {name} 插值。缺 key（理论上类型系统已杜绝）回落 zh-CN 再回落 key 本身
 * ——文案缺失不能渲染出 "[object Object]" 或空白。
 *
 * v0.29.2：自动注入 `{pet}` = 当前宠物自称；显式 vars 里的 pet 优先（测试可覆盖）。
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = dictionaries[currentLocale][key] ?? zhCN[key] ?? key;
  const merged: Record<string, string | number> = { pet: currentPetName, ...vars };
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in merged ? String(merged[name]) : match,
  );
}

/**
 * 语言设置（system / zh-CN / en）→ 实际 Locale。
 * "system" 按 navigator.language 判：zh 开头用中文，其余英文（检测失败回落中文
 * ——这个产品的第一语言）。
 */
export function resolveLocale(setting: string | undefined): Locale {
  if (setting === "zh-CN" || setting === "en") return setting;
  if (setting === "system") {
    try {
      return navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
    } catch {
      return "zh-CN";
    }
  }
  return "zh-CN";
}

/**
 * 在本窗口安装语言监听（每个 WebView 入口调用一次，与 installThemeWatcher 并列）：
 * 读初始设置 + settingsChanged 时重读——切换语言**不需要重启**（任务单验收标准）。
 */
export function installLocaleWatcher(): () => void {
  const refresh = () => {
    void loadSettings()
      .then(settings => {
        setLocale(resolveLocale(settings.locale));
        setPetSelfName(settings.petSelfName);
      })
      .catch(() => undefined); // 读不到设置保持现状——语言是外观，不该报错打断功能
  };
  refresh();
  let off: (() => void) | undefined;
  void listen(STATE_EVENTS.settingsChanged, refresh).then(unlisten => {
    off = unlisten;
  });
  return () => off?.();
}
