import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { PomodoroService } from "@/services/timers";
import { pomodoroControl } from "@/services/pomodoro-control";
import { petState } from "@/services/pet-state";

vi.mock("@/services/settings", () => ({ loadSettings: async () => ({
  standupIntervalMin: 60, pomodoroFocusMin: 10, pomodoroBreakMin: 1, notificationsEnabled: false,
}) }));
vi.mock("@/services/presence", () => ({ presenceService: { current: "active" } }));
vi.mock("@/services/notifications", () => ({ notify: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  mockIPC(() => undefined, { shouldMockEvents: true });
  petState.clearSystem("pomodoro");
});
afterEach(() => { vi.clearAllTimers(); clearMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("刚打开聊天窗也能查询权威状态与设置时长", async () => {
  const service = new PomodoroService();
  await service.start();
  expect(await pomodoroControl.status()).toMatchObject({ ok: true, data: { phase: "idle", focusMin: 10 } });
  service.startFocus();
  expect(await pomodoroControl.status()).toMatchObject({ ok: true, data: { phase: "focus", remainingSec: 600 } });
});

it("同时发起两次启动：只有一次成功，不依赖聊天窗缓存", async () => {
  const service = new PomodoroService();
  await service.start();
  const results = await Promise.all([pomodoroControl.start(), pomodoroControl.start()]);
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.filter(r => !r.ok)).toHaveLength(1);
  expect(await pomodoroControl.stop()).toMatchObject({ ok: true, data: { phase: "idle" } });
});

it("宠物服务没响应时返回失败，不能虚报启动成功", async () => {
  const pending = pomodoroControl.start();
  await vi.advanceTimersByTimeAsync(3500);
  expect(await pending).toMatchObject({ ok: false });
});

it("恶意或损坏时长通过事件进入服务也会被拒绝", async () => {
  const service = new PomodoroService();
  await service.start();
  expect(await pomodoroControl.start(Infinity)).toMatchObject({ ok: false });
  expect(service.status().phase).toBe("idle");
});
