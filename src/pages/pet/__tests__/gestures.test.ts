import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PetGestureController } from "../gestures";

const actions = { singleClick: vi.fn(), doubleClick: vi.fn(), drag: vi.fn() };
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function tap(gestures: PetGestureController, x = 20, y = 30) {
  gestures.pointerDown(1, x, y, 0);
  gestures.pointerUp(1, x, y);
}

it("单击仅确认一次，轻微手抖不启动拖动", async () => {
  const gestures = new PetGestureController(actions);
  gestures.pointerDown(1, 20, 30, 0);
  gestures.pointerMove(1, 22, 32);
  gestures.pointerUp(1, 22, 32);
  await vi.advanceTimersByTimeAsync(500);
  expect(actions.singleClick).toHaveBeenCalledTimes(1);
  expect(actions.drag).not.toHaveBeenCalled();
});
it("双击只打开聊天，不重置站立提醒", async () => {
  const gestures = new PetGestureController(actions);
  tap(gestures);
  await vi.advanceTimersByTimeAsync(150);
  tap(gestures);
  await vi.advanceTimersByTimeAsync(1000);
  expect(actions.doubleClick).toHaveBeenCalledTimes(1);
  expect(actions.singleClick).not.toHaveBeenCalled();
});
it("拖动只启动一次，不产生单击或双击", async () => {
  const gestures = new PetGestureController(actions);
  gestures.pointerDown(1, 20, 30, 0);
  expect(gestures.pointerMove(1, 25, 30)).toBe(true);
  gestures.pointerMove(1, 40, 30);
  gestures.pointerUp(1, 40, 30);
  await vi.advanceTimersByTimeAsync(1000);
  expect(actions.drag).toHaveBeenCalledTimes(1);
  expect(actions.singleClick).not.toHaveBeenCalled();
  expect(actions.doubleClick).not.toHaveBeenCalled();
});
it("右键和不匹配指针不执行宠物动作", async () => {
  const gestures = new PetGestureController(actions);
  gestures.pointerDown(1, 20, 30, 2);
  gestures.pointerUp(1, 20, 30);
  gestures.pointerDown(1, 20, 30, 0);
  gestures.pointerMove(2, 100, 100);
  gestures.pointerUp(2, 20, 30);
  await vi.advanceTimersByTimeAsync(1000);
  expect(actions.singleClick).not.toHaveBeenCalled();
  expect(actions.drag).not.toHaveBeenCalled();
});
it("打开菜单、失焦或卸载取消尚未确认的单击", async () => {
  const gestures = new PetGestureController(actions);
  tap(gestures);
  gestures.cancel();
  await vi.advanceTimersByTimeAsync(1000);
  expect(actions.singleClick).not.toHaveBeenCalled();
});
it("间隔超出双击窗口的两个单击分别执行", async () => {
  const gestures = new PetGestureController(actions);
  tap(gestures);
  await vi.advanceTimersByTimeAsync(501);
  tap(gestures);
  await vi.advanceTimersByTimeAsync(501);
  expect(actions.singleClick).toHaveBeenCalledTimes(2);
  expect(actions.doubleClick).not.toHaveBeenCalled();
});

describe("clickFeedback（v0.9.0 手感优化：视觉反馈不等双击判定）", () => {
  const visual = { ...actions, clickFeedback: vi.fn() };

  it("抬指瞬间立即触发，不等 500ms 判定窗口", () => {
    const gestures = new PetGestureController(visual);
    tap(gestures);
    expect(visual.clickFeedback).toHaveBeenCalledTimes(1);
    expect(visual.singleClick).not.toHaveBeenCalled(); // 语义动作仍在等判定
    vi.advanceTimersByTime(500);
    expect(visual.singleClick).toHaveBeenCalledTimes(1);
  });

  it("双击时两次抬指都反馈，但语义动作只有双击", async () => {
    const gestures = new PetGestureController(visual);
    tap(gestures);
    await vi.advanceTimersByTimeAsync(150);
    tap(gestures);
    await vi.advanceTimersByTimeAsync(1000);
    expect(visual.clickFeedback).toHaveBeenCalledTimes(2);
    expect(visual.doubleClick).toHaveBeenCalledTimes(1);
    expect(visual.singleClick).not.toHaveBeenCalled();
  });

  it("拖动不触发点击反馈（拖动有自己的手感通道）", () => {
    const gestures = new PetGestureController(visual);
    gestures.pointerDown(1, 20, 30, 0);
    expect(gestures.pointerMove(1, 30, 30)).toBe(true);
    gestures.pointerUp(1, 30, 30);
    vi.advanceTimersByTime(600);
    expect(visual.clickFeedback).not.toHaveBeenCalled();
    expect(visual.drag).toHaveBeenCalledTimes(1);
  });
});
