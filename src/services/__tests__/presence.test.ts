import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { PresenceService } from "@/services/presence";
import { petState } from "@/services/pet-state";

let idleSec = 0;
beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  idleSec = 0;
  mockIPC(cmd => {
    if (cmd === "get_idle_seconds") return idleSec;
  }, { shouldMockEvents: true });
  petState.clearPresence();
  petState.clearSystem("pomodoro");
});
afterEach(() => { vi.clearAllTimers(); clearMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("无输入五分钟进入 sleep，恢复输入后下一次轮询退出", async () => {
  const service = new PresenceService();
  service.start();
  idleSec = 299;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(service.current).toBe("active");
  idleSec = 300;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(service.current).toBe("away");
  expect(petState.current).toBe("sleep");
  idleSec = 0;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(service.current).toBe("active");
  expect(petState.current).toBe("idle");
  service.stop();
});

it("在场检测不能抢占番茄钟状态", async () => {
  const service = new PresenceService();
  petState.setSystem("focus", undefined, "pomodoro");
  idleSec = 600;
  service.start();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(service.current).toBe("away");
  expect(petState.current).toBe("focus");
  petState.clearSystem("pomodoro");
  expect(petState.current).toBe("sleep");
  service.stop();
});

it("OS 查询失败按在场处理，停止后不再继续查询", async () => {
  const query = vi.fn(() => { throw new Error("OS 不可用"); });
  mockIPC(cmd => { if (cmd === "get_idle_seconds") return query(); }, { shouldMockEvents: true });
  const service = new PresenceService();
  service.start();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(service.current).toBe("active");
  service.stop();
  const calls = query.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(query).toHaveBeenCalledTimes(calls);
});
