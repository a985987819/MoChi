import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { subscribeHeartbeat } from "@/services/heartbeat";
import { STATE_EVENTS } from "@/shared/events";

beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  mockIPC(() => undefined, { shouldMockEvents: true });
});
afterEach(() => { vi.clearAllTimers(); clearMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("不推进 JS 定时器时，原生事件也能检查过期时间", async () => {
  const callback = vi.fn();
  const off = await subscribeHeartbeat(callback);
  vi.setSystemTime(Date.now() + 120_000);
  await emit(STATE_EVENTS.nativeTick);
  expect(callback).toHaveBeenCalledTimes(1);
  off();
});

it("同秒合并原生和 JS 节拍，解绑后不再执行", async () => {
  vi.setSystemTime(0);
  const callback = vi.fn();
  const off = await subscribeHeartbeat(callback);
  await vi.advanceTimersByTimeAsync(1000);
  await emit(STATE_EVENTS.nativeTick);
  expect(callback).toHaveBeenCalledTimes(1);
  off();
  await vi.advanceTimersByTimeAsync(1000);
  await emit(STATE_EVENTS.nativeTick);
  expect(callback).toHaveBeenCalledTimes(1);
});
