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
