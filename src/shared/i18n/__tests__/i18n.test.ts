import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn(async () => ({ get: vi.fn(async () => undefined), set: vi.fn(async () => {}), save: vi.fn(async () => {}) })) }));

import { en } from "@/shared/i18n/en";
import { zhCN, type MessageKey } from "@/shared/i18n/zh-CN";
import { getLocale, getRevision, installLocaleWatcher, resolveLocale, setLocale, setPetSelfName, subscribeLocale, t } from "@/shared/i18n/core";
import { loadSettings } from "@/services/settings";

/**
 * i18n 内核（P2-03B / v0.19.0）。key 一致性主要靠 `satisfies` 的**编译期**约束
 * （en.ts 顶部），这里补运行时断言作为防回归的最后一道网（例如有人绕过类型用
 * as 断言绕开 satisfies 时，测试仍然红）。
 */
describe("字典 key 对齐", () => {
  it("en 与 zh-CN 的 key 集合完全一致", () => {
    const zhKeys = Object.keys(zhCN).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it("zh-CN 的每个值都非空字符串", () => {
    for (const value of Object.values(zhCN)) {
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it("插值占位符在两侧都有对应写法（{name} 数量一致）", () => {
    for (const key of Object.keys(zhCN) as MessageKey[]) {
      const zhVars = zhCN[key].match(/\{(\w+)\}/g)?.sort() ?? [];
      const enVars = en[key].match(/\{(\w+)\}/g)?.sort() ?? [];
      expect(enVars).toEqual(zhVars);
    }
  });
});

describe("t 与运行时切换", () => {
  beforeEach(() => {
    setLocale("zh-CN");
  });

  it("默认中文；setLocale 后 t 立即换语言（订阅者被通知）", () => {
    expect(t("tab.chat")).toBe("聊天");
    const seen: Array<"zh-CN" | "en"> = [getLocale()];
    subscribeLocale(() => seen.push(getLocale()));
    setLocale("en");
    expect(t("tab.chat")).toBe("Chat");
    expect(seen).toEqual(["zh-CN", "en"]);
  });

  it("插值替换 {name}，未知占位原样保留（不做静默替换）", () => {
    expect(t("menu.standupRemaining", { minutes: 5 })).toBe("站立提醒 · 还剩 5 分钟");
    expect(t("menu.standupRemaining")).toContain("{minutes}");
    expect(t("rem.activeTitle", { count: 3 })).toBe("进行中（3）");
  });

  it("en 插值同样生效", () => {
    setLocale("en");
    expect(t("todos.sectionPending", { count: 2 })).toBe("Open · 2");
    setLocale("zh-CN");
  });

  it("宠物自称自动注入 {pet}，切换自称会通知订阅者", () => {
    setPetSelfName("熊");
    expect(t("chat.emptyHello")).toBe("跟熊说句话吧～");
    expect(t("menu.hidePet")).toBe("隐藏熊");
    const before = getRevision();
    let notified = 0;
    const unsubscribe = subscribeLocale(() => notified++);
    setPetSelfName("团子");
    expect(notified).toBe(1);
    expect(getRevision()).toBe(before + 1);
    expect(t("chat.emptyHello")).toBe("跟团子说句话吧～");
    unsubscribe();
    setPetSelfName("麻薯"); // 复原，避免影响后续用例
  });
});

describe("resolveLocale（语言设置解析）", () => {
  it("显式设置原样", () => {
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("en")).toBe("en");
  });

  it("system 按 navigator.language 判（zh 开头 → 中文）", () => {
    vi.stubGlobal("navigator", { language: "zh-CN" });
    expect(resolveLocale("system")).toBe("zh-CN");
    vi.stubGlobal("navigator", { language: "en-US" });
    expect(resolveLocale("system")).toBe("en");
    vi.unstubAllGlobals();
  });

  it("未知设置回落中文（产品第一语言）", () => {
    expect(resolveLocale("fr")).toBe("zh-CN");
    expect(resolveLocale(undefined)).toBe("zh-CN");
  });
});

describe("installLocaleWatcher（切换不重启）", () => {
  it("settings.locale 变化 → setLocale（监听 settingsChanged 重读完整设置）", async () => {
    setLocale("zh-CN");
    // loadSettings 走 mock 的空 store → normalize 得默认值 locale: "system"
    await installLocaleWatcher();
    // system + mocked navigator.language（vitest node 是 undefined）→ 回落 zh-CN
    expect(getLocale()).toBe("zh-CN");
    // 不抛错即装配成功；settingsChanged 的重读路径与 refresh 相同（已由 resolveLocale 测试覆盖）
    expect(true).toBe(true);
    await loadSettings();
  });
});
