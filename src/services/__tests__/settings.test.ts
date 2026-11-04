import { beforeEach, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({ raw: undefined as unknown, set: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({
  get: async () => store.raw,
  set: store.set,
}) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
import { defaultSettings, isProviderReady, loadSettings, saveSettings } from "@/services/settings";

beforeEach(() => { store.raw = undefined; store.set.mockClear(); });

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
});
it("真实提供商缺 Key 时明确拒绝，核心计时不经过此闸门", () => {
  expect(isProviderReady({ ...defaultSettings(), providerId: "deepseek" }).ok).toBe(false);
});
