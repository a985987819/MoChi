import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { hostServices } from "@/services/host-services";
beforeEach(() => { vi.stubGlobal("window", globalThis); vi.useFakeTimers(); mockIPC(() => undefined, { shouldMockEvents: true }); });
afterEach(() => { vi.clearAllTimers(); clearMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("失败服务单独重试，成功服务不重复初始化，退出后不再启动", async () => {
  const first = { start: vi.fn().mockRejectedValueOnce(new Error("临时失败")).mockResolvedValue(undefined), dispose: vi.fn() };
  const second = { start: vi.fn(async () => {}), dispose: vi.fn() };
  const off = await hostServices([first, second]);
  await vi.advanceTimersByTimeAsync(6000);
  expect(first.start).toHaveBeenCalledTimes(2);
  expect(second.start).toHaveBeenCalledTimes(1);
  off();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(first.start).toHaveBeenCalledTimes(2);
  expect(first.dispose).toHaveBeenCalled();
  expect(second.dispose).toHaveBeenCalled();
});

it("慢启动不会在每个心跳重复发起，退出后完成会再次释放", async () => {
  let resolve: () => void = () => {};
  const pending = new Promise<void>(r => { resolve = r; });
  const service = { start: vi.fn(() => pending), dispose: vi.fn() };
  const off = await hostServices([service]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(service.start).toHaveBeenCalledTimes(1);
  off(); resolve();
  await vi.advanceTimersByTimeAsync(1);
  expect(service.dispose).toHaveBeenCalledTimes(2);
});
