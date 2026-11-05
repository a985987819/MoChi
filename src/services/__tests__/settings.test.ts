import { beforeEach, describe, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({ raw: undefined as unknown, set: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({
  get: async () => store.raw,
  set: store.set,
  save: store.save,
}) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));
import { defaultSettings, isProviderReady, loadSettings, normalize, saveSettings } from "@/services/settings";

/**
 * 设置单测（合并两侧）：
 * - normalize 纯函数（本地 v0.9.0 施工单 §7.1：老配置升级 + 脏 JSON 是真实事故源）；
 * - store 交互（远程 v0.8.2：串行落盘、失败恢复、称呼归一）。
 * normalize 是 loadSettings 的唯一入口——store 里的任何 JSON 都要经过它。
 */

beforeEach(() => { store.raw = undefined; store.set.mockReset(); store.save.mockReset(); });

describe("settings normalize（纯函数）", () => {
  it("非对象输入（null/字符串/数组）→ 全默认", () => {
    for (const raw of [null, undefined, "x", 42, []]) {
      expect(normalize(raw)).toEqual(defaultSettings());
    }
  });

  it("老版本配置（缺新字段）→ 补默认且不丢旧值", () => {
    const old = {
      providerId: "deepseek",
      apiKeys: { deepseek: "sk-old" },
      models: { deepseek: "deepseek-chat" },
      standupIntervalMin: 45,
      pomodoroFocusMin: 30,
      pomodoroBreakMin: 10,
      notificationsEnabled: false,
      // 没有 onboardingDone / shortcutEnabled / autostartEnabled / petScale / 称呼
    };
    const s = normalize(old);
    expect(s.providerId).toBe("deepseek");
    expect(s.apiKeys).toEqual({ deepseek: "sk-old" });
    expect(s.standupIntervalMin).toBe(45);
    // 升级用户会看到一次引导（v0.9.0 之前没有引导）——期望行为
    expect(s.onboardingDone).toBe(false);
    expect(s.shortcutEnabled).toBe(true);
    expect(s.autostartEnabled).toBe(false);
    expect(s.petScale).toBe(1);
    expect(s.petSelfName).toBe("麻薯");
    expect(s.userNickname).toBe("人");
  });

  it("数值越界被夹紧（0/负数/离谱值）", () => {
    const s = normalize({ standupIntervalMin: 0, pomodoroFocusMin: -5, pomodoroBreakMin: 999 });
    expect(s.standupIntervalMin).toBe(1); // 夹到下限
    expect(s.pomodoroFocusMin).toBe(5);
    expect(s.pomodoroBreakMin).toBe(30); // 夹到上限
  });

  it("非数值/NaN 落到默认值", () => {
    const s = normalize({ standupIntervalMin: "60", pomodoroFocusMin: Number.NaN });
    expect(s.standupIntervalMin).toBe(60); // 字符串 → 默认
    expect(s.pomodoroFocusMin).toBe(25);
  });

  it("未知提供商回退 mock", () => {
    expect(normalize({ providerId: "no-such-provider" }).providerId).toBe("mock");
    expect(normalize({ providerId: "deepseek" }).providerId).toBe("deepseek");
  });

  it("嵌套字段类型不对 → 空对象兜底（不抛错）", () => {
    const s = normalize({ apiKeys: "not-an-object", models: 123, notificationsEnabled: "yes" });
    expect(s.apiKeys).toEqual({});
    expect(s.models).toEqual({});
    expect(s.notificationsEnabled).toBe(true);
  });

  it("petScale 只认三档（浮点误差容差内），非法值回落 1", () => {
    expect(normalize({ petScale: 0.8 }).petScale).toBe(0.8);
    expect(normalize({ petScale: 1.2 }).petScale).toBe(1.2);
    expect(normalize({ petScale: 0.9 }).petScale).toBe(1); // 非档位
    expect(normalize({ petScale: 0.80000000001 }).petScale).toBe(0.8); // 浮点误差容差
    expect(normalize({ petScale: "1" }).petScale).toBe(1); // 类型不对
  });
});

describe("settings load/save（store 交互）", () => {
  it("初装默认设置不依赖 API Key，计时间隔正确", async () => {
    const settings = await loadSettings();
    expect(settings).toEqual(defaultSettings());
    expect(isProviderReady(settings).ok).toBe(true);
  });

  it("旧设置与无效计时参数被归一化", async () => {
    store.raw = { providerId: "bad", standupIntervalMin: 0, pomodoroFocusMin: 999, pomodoroBreakMin: Number.NaN };
    expect(await loadSettings()).toMatchObject({ providerId: "mock", standupIntervalMin: 1, pomodoroFocusMin: 90, pomodoroBreakMin: 5, onboardingDone: false });
  });

  it("更换提供商保存后仍保留配置桶", async () => {
    const settings = { ...defaultSettings(), providerId: "deepseek", models: { deepseek: "deepseek-chat", mock: "mock" } };
    await saveSettings(settings);
    expect(store.set).toHaveBeenCalledWith("app", settings);
    expect(store.save).toHaveBeenCalled();
  });

  it("写盘失败后的下一次保存仍可执行，快照按用户操作顺序落盘", async () => {
    const first = { ...defaultSettings(), standupIntervalMin: 5 };
    const second = { ...defaultSettings(), standupIntervalMin: 10 };
    store.save.mockRejectedValueOnce(new Error("临时磁盘错误"));
    const one = saveSettings(first);
    const two = saveSettings(second);
    await expect(one).rejects.toThrow("临时磁盘错误");
    await expect(two).resolves.toBeUndefined();
    expect(store.set.mock.calls.map(call => call[1].standupIntervalMin)).toEqual([5, 10]);
  });

  it("真实提供商缺 Key 时明确拒绝，核心计时不经过此闸门", () => {
    expect(isProviderReady({ ...defaultSettings(), providerId: "deepseek" }).ok).toBe(false);
  });

  it("旧配置缺称呼时使用麻薯与人，已有称呼去首尾空白后保留", async () => {
    store.raw = { providerId: "mock" };
    expect(await loadSettings()).toMatchObject({ petSelfName: "麻薯", userNickname: "人" });
    store.raw = { petSelfName: "  小团子  ", userNickname: "  阿明  " };
    expect(await loadSettings()).toMatchObject({ petSelfName: "小团子", userNickname: "阿明" });
  });

  it("空白称呼回落默认值，保存中的称呼立即读取也能一致", async () => {
    store.set.mockImplementation(async (_key: string, value: unknown) => { store.raw = value; });
    const save = saveSettings({ ...defaultSettings(), petSelfName: "  ", userNickname: "\t" });
    const loaded = loadSettings();
    await save;
    expect(await loaded).toMatchObject({ petSelfName: "麻薯", userNickname: "人" });
    const changed = saveSettings({ ...defaultSettings(), petSelfName: "团团", userNickname: "小林" });
    expect(await loadSettings()).toMatchObject({ petSelfName: "团团", userNickname: "小林" });
    await changed;
  });
});
