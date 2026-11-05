import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimedBubble } from "../bubble-display";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("显示七秒后先离场，二百毫秒后移除", async () => {
  const changed = vi.fn();
  const bubble = new TimedBubble(changed);
  await bubble.show(async () => "喝水啦");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ line: "喝水啦", leaving: false }));
  await vi.advanceTimersByTimeAsync(7000);
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ line: "喝水啦", leaving: true }));
  await vi.advanceTimersByTimeAsync(200);
  expect(changed).toHaveBeenLastCalledWith(null);
});

it("晚到的旧上下文不能覆盖新点击，旧定时器不能提前清除新气泡", async () => {
  const changed = vi.fn();
  const bubble = new TimedBubble<string>(changed);
  let release: (line: string) => void = () => {};
  const first = bubble.show(() => new Promise(resolve => { release = resolve; }));
  await bubble.show(async () => "新文案");
  release("旧文案");
  await first;
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ line: "新文案" }));
  await vi.advanceTimersByTimeAsync(6000);
  await bubble.show(async () => "再摸一下");
  await vi.advanceTimersByTimeAsync(1200);
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ line: "再摸一下", leaving: false }));
});

it("菜单或双击撤回后，尚未返回的加载不能重新显示", async () => {
  const changed = vi.fn();
  const bubble = new TimedBubble<string>(changed);
  let release: (line: string) => void = () => {};
  const loading = bubble.show(() => new Promise(resolve => { release = resolve; }));
  bubble.cancel();
  release("不该出现");
  await loading;
  expect(changed).toHaveBeenLastCalledWith(null);
  expect(changed).not.toHaveBeenCalledWith(expect.objectContaining({ line: "不该出现" }));
});

it("卸载后异步成功与定时器均不写状态，重新挂载可继续展示", async () => {
  const changed = vi.fn();
  const bubble = new TimedBubble(changed);
  await bubble.show(async () => "第一条");
  let release: (line: string) => void = () => {};
  const late = bubble.show(() => new Promise<string>(resolve => { release = resolve; }));
  bubble.dispose();
  const count = changed.mock.calls.length;
  release("卸载后才到达");
  await late;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(changed).toHaveBeenCalledTimes(count);
  bubble.activate();
  await bubble.show(async () => "回来啦");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ line: "回来啦" }));
});

it("加载失败不抛出未处理异常，也不留下假气泡", async () => {
  const changed = vi.fn();
  const bubble = new TimedBubble(changed);
  await expect(bubble.show(async () => { throw new Error("暂时不可读"); })).resolves.toBeUndefined();
  expect(changed).toHaveBeenLastCalledWith(null);
});

it("被菜单取消的异步上下文不消耗去重或欢迎选择器", async () => {
  const bubble = new TimedBubble<string>(vi.fn());
  const select = vi.fn((context: string) => context);
  let release: (context: string) => void = () => {};
  const pending = bubble.showContext(() => new Promise<string>(resolve => { release = resolve; }), select);
  bubble.cancel();
  release("欢迎回来");
  await pending;
  expect(select).not.toHaveBeenCalled();
});
