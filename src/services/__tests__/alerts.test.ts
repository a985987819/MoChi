import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { subscribeAppAlerts, showAppAlert, dismissAppAlert, type AppAlert } from "@/services/alerts";
import { STATE_EVENTS } from "@/shared/events";

const one: AppAlert = { id: "one", kind: "reminder", title: "提醒", body: "喝水" };
const two: AppAlert = { ...one, id: "two", body: "休息" };
let snapshot: Promise<AppAlert | null>;
let resolveSnapshot: (alert: AppAlert | null) => void;
const flushSnapshot = async () => { await snapshot; await new Promise<void>(resolve => setTimeout(resolve, 0)); };

beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  snapshot = new Promise(resolve => { resolveSnapshot = resolve; });
  mockIPC(command => command === "get_app_alert" ? snapshot : undefined, { shouldMockEvents: true });
});
afterEach(() => { clearMocks(); vi.unstubAllGlobals(); });

it("首次监听后读取原生快照，未就绪期间的提醒不会丢失", async () => {
  const received = vi.fn();
  const off = await subscribeAppAlerts(received, vi.fn());
  resolveSnapshot(one);
  await flushSnapshot();
  expect(received).toHaveBeenCalledWith(one);
  off();
});

it("慢快照不能覆盖已经到达的下一条提醒", async () => {
  const received = vi.fn();
  const off = await subscribeAppAlerts(received, vi.fn());
  await emit(STATE_EVENTS.appAlertChanged, two);
  resolveSnapshot(one);
  await flushSnapshot();
  expect(received).toHaveBeenCalledTimes(1);
  expect(received).toHaveBeenLastCalledWith(two);
  off();
});

it("卸载后不再接收广播或尚未返回的快照", async () => {
  const received = vi.fn();
  const off = await subscribeAppAlerts(received, vi.fn());
  off();
  await emit(STATE_EVENTS.appAlertChanged, two);
  resolveSnapshot(one);
  await flushSnapshot();
  expect(received).not.toHaveBeenCalled();
});

it("原生交付/关闭失败必须回传调用服务，不能伪报成功", async () => {
  mockIPC(() => { throw new Error("窗口不可用"); });
  await expect(showAppAlert(one)).rejects.toThrow("窗口不可用");
  await expect(dismissAppAlert(one.id)).rejects.toThrow("窗口不可用");
});
