import { describe, expect, it } from "vitest";
import type { AppSettings } from "../settings";
import { createSettingsSaveQueue, type TimerScheduler } from "../settings-debounce";

/**
 * 设置落盘防抖单测（P0-02）。
 * 用假调度器手动推进时间，断言 persist 的调用次数与 changedKeys 的合并——
 * 这是「行为型逻辑」，靠肉眼验证不了（施工单 §7.1）。
 */

/** 假钟：记录每次 set 的回调，测试手动 fire 模拟时间到点 */
function fakeScheduler(): TimerScheduler & { fire(): void; timerCount(): number; delayMs(): number | null } {
  let pending: (() => void) | null = null;
  let lastDelay: number | null = null;
  return {
    set(fn, ms) {
      pending = fn;
      lastDelay = ms;
      return { fake: true }; // 句柄：本假钟用 pending 变量管理生命周期，无需真实句柄
    },
    clear(_handle) {
      pending = null;
      lastDelay = null;
    },
    fire() {
      const fn = pending;
      pending = null;
      fn?.();
    },
    timerCount: () => (pending ? 1 : 0),
    delayMs: () => lastDelay,
  };
}

const base: AppSettings = {
  providerId: "mock",
  apiKeys: {},
  models: {},
  standupIntervalMin: 60,
  pomodoroFocusMin: 25,
  pomodoroBreakMin: 5,
  notificationsEnabled: true,
  onboardingDone: false,
  shortcutEnabled: true,
};

describe("createSettingsSaveQueue", () => {
  it("防抖窗口内连续 queue 只落盘一次（最后一次为准）", () => {
    const clock = fakeScheduler();
    const calls: Array<{ keys: string[]; standup: number }> = [];
    const q = createSettingsSaveQueue(
      (s, keys) => {
        calls.push({ keys, standup: s.standupIntervalMin });
      },
      350,
      clock,
    );

    q.queue({ ...base, standupIntervalMin: 3 }, ["standupIntervalMin"]);
    q.queue({ ...base, standupIntervalMin: 30 }, ["standupIntervalMin"]);
    expect(calls).toHaveLength(0); // 窗口内还没落盘
    expect(clock.timerCount()).toBe(1); // 只有一个挂起的计时器

    clock.fire();
    expect(calls).toHaveLength(1);
    expect(calls[0].standup).toBe(30); // 最后一次的值
    expect(clock.timerCount()).toBe(0);
  });

  it("changedKeys 取并集：两次不同键的修改合并进同一次落盘", () => {
    const clock = fakeScheduler();
    const calls: string[][] = [];
    const q = createSettingsSaveQueue(
      (_s, keys) => {
        calls.push(keys);
      },
      350,
      clock,
    );

    q.queue({ ...base, standupIntervalMin: 30 }, ["standupIntervalMin"]);
    q.queue({ ...base, notificationsEnabled: false }, ["notificationsEnabled"]);
    clock.fire();
    expect(calls).toHaveLength(1);
    expect(calls[0].sort()).toEqual(["notificationsEnabled", "standupIntervalMin"]);
  });

  it("每次 queue 都重置计时器（等最后一次输入后 350ms）", () => {
    const clock = fakeScheduler();
    const q = createSettingsSaveQueue(() => undefined, 350, clock);
    q.queue(base, ["providerId"]);
    expect(clock.delayMs()).toBe(350);
    q.queue(base, ["providerId"]); // 第二次 queue：计时器被重置（仍是 1 个、延迟重新计）
    expect(clock.timerCount()).toBe(1);
  });

  it("flush 立即落盘 pending，不再等窗口", () => {
    const clock = fakeScheduler();
    const calls: AppSettings[] = [];
    const q = createSettingsSaveQueue(s => {
      calls.push(s);
    }, 350, clock);
    q.queue({ ...base, onboardingDone: true }, ["onboardingDone"]);
    q.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].onboardingDone).toBe(true);
    expect(q.hasPending()).toBe(false);
    clock.fire(); // 旧计时器已取消：不该二次落盘
    expect(calls).toHaveLength(1);
  });

  it("无 pending 时 flush 是空操作", () => {
    const clock = fakeScheduler();
    const calls: unknown[] = [];
    const q = createSettingsSaveQueue(s => {
      calls.push(s);
    }, 350, clock);
    q.flush();
    expect(calls).toHaveLength(0);
  });
});
