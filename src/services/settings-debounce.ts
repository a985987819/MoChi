/**
 * 设置落盘防抖 —— v0.9.0 P0-02。
 *
 * # 为什么需要它
 *
 * 设置页是「字段级即时落盘」设计（无保存按钮），但 API Key 输入框、数字输入框
 * 都是字符级 onChange——输入 `30` 会触发两次 saveSettings，每次都写盘 + 广播
 * settingsChanged，把站立提醒计时器反复重排。防抖收敛为「最后一次输入后
 * 350ms 才真正写盘 + 广播一次」。
 *
 * # 为什么是独立文件
 *
 * 本模块**不 import 任何 @tauri-apps/***：vitest 跑在 node 环境
 * （vite.config.ts 的测试纪律——被测模块不得依赖 tauri API），而 settings.ts
 * 顶层就 import 了 plugin-store 与 api/event。防抖机制抽在这里保持纯函数可测，
 * settings.ts 里只留几行适配（queueSettingsSave / flushSettingsSave）。
 *
 * # 语义
 *
 * - queue：替换 pending 值并重置计时器（「最后一次为准」）——订阅方对变更的
 *   相关性判断由各自比较新旧值完成（v0.8.2 起 timers 自己 diff），本模块不再
 *   携带 changedKeys（合并时移除：唯一消费者已改用值比较，携带键集是死代码）；
 * - flush：立即落盘 pending（若有的话）——输入框 blur / 组件卸载时调用，
 *   保证「改完立刻关窗」不丢最后一次写盘。
 */

import type { AppSettings } from "./settings";

/** 可注入的时间调度器：生产环境包 window.setTimeout，测试用假钟手动推进 */
export interface TimerScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const windowScheduler: TimerScheduler = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: handle => window.clearTimeout(handle as number),
};

/** 防抖窗口（毫秒）：比人手输入的最短停顿略长，比"改完切 Tab"短得多 */
export const SETTINGS_SAVE_DEBOUNCE_MS = 350;

export interface SettingsSaveQueue {
  /** 记录一次待落盘修改（字符级输入的每次 onChange 都调它，内部自动合并） */
  queue(settings: AppSettings): void;
  /** 立即落盘 pending（输入框 blur / 组件卸载时调用） */
  flush(): void;
  /** 是否有未落盘的修改（测试断言用） */
  hasPending(): boolean;
}

export function createSettingsSaveQueue(
  persist: (settings: AppSettings) => void | Promise<void>,
  delayMs: number = SETTINGS_SAVE_DEBOUNCE_MS,
  scheduler: TimerScheduler = windowScheduler,
): SettingsSaveQueue {
  let pending: AppSettings | null = null;
  let handle: unknown = null;

  const fire = (): void => {
    handle = null;
    const settings = pending;
    pending = null;
    if (settings) void persist(settings);
  };

  return {
    queue(settings) {
      pending = settings; // 最后一次为准：覆盖旧 pending
      if (handle != null) scheduler.clear(handle); // 重置计时器：连续输入只等最后一次
      handle = scheduler.set(fire, delayMs);
    },
    flush() {
      if (handle != null) {
        scheduler.clear(handle);
        handle = null;
      }
      fire();
    },
    hasPending: () => pending != null,
  };
}
