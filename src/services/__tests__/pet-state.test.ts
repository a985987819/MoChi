import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { PetStateManager } from "@/services/pet-state";

beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  mockIPC(() => undefined, { shouldMockEvents: true });
});
afterEach(() => { vi.clearAllTimers(); clearMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("提醒覆盖专注，短提醒到期不能释放仍未确认的站立提醒", async () => {
  const state = new PetStateManager();
  state.setSystem("focus", undefined, "pomodoro");
  state.setSystem("alert", undefined, "standup");
  state.setSystem("alert", 8, "reminder");
  await vi.advanceTimersByTimeAsync(8000);
  expect(state.current).toBe("alert");
  state.clearSystem("standup");
  expect(state.current).toBe("focus");
});

it("情绪不能抢占系统，清除系统后依次恢复在场状态和情绪", () => {
  const state = new PetStateManager();
  state.setMood("happy", 10);
  state.setPresence("sleep");
  state.setSystem("focus", undefined, "pomodoro");
  expect(state.current).toBe("focus");
  state.clearSystem("pomodoro");
  expect(state.current).toBe("sleep");
  state.clearPresence();
  expect(state.current).toBe("happy");
});

it("同级系统状态取最新，旧服务清理和定时器不会清掉新状态", async () => {
  const state = new PetStateManager();
  state.setSystem("focus", undefined, "pomodoro");
  state.setSystem("break", 8, "demo");
  expect(state.current).toBe("break");
  state.setSystem("stretch", 2, "demo");
  await vi.advanceTimersByTimeAsync(2000);
  expect(state.current).toBe("focus");
  await vi.advanceTimersByTimeAsync(6000);
  expect(state.current).toBe("focus");
});
