import { beforeEach, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({ raw: undefined as unknown, set: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({
  get: async () => store.raw,
  set: store.set,
  save: store.save,
}) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));
import { defaultSettings, isProviderReady, loadSettings, saveSettings } from "@/services/settings";

beforeEach(() => { store.raw = undefined; store.set.mockReset(); store.save.mockReset(); });

it("初装默认设置不依赖 API Key，计时间隔正确", async () => {
  const settings = await loadSettings();
  expect(settings).toEqual(defaultSettings());
  expect(isProviderReady(settings).ok).toBe(true);
});
it("旧设置与无效计时参数被归一化", async () => {
  store.raw = { providerId: "bad", standupIntervalMin: 0, pomodoroFocusMin: 999, pomodoroBreakMin: NaN };
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
