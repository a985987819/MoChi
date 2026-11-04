import { emit } from "@tauri-apps/api/event";

/**
 * 本文件是 Mochi 的**通信协议常量表**，与 `src-tauri/src/lib.rs` 的 `EVT_*` 常量一一对应。
 * 改名必须两侧同步。命名规范：
 * - `ui://<动作>`    —— UI 发起，请求 Rust 做系统操作；
 * - `state://<变化>` —— 服务/状态层广播，供任意窗口订阅（纯前端跨窗口，不经 Rust）。
 */

/** UI → Rust 事件（Rust 侧 lib.rs 监听） */
export const UI_EVENTS = {
  /**
   * 打开（显示并聚焦）聊天窗口。载荷：{ tab?: "chat"|"todos"|"pomodoro"|"settings" }
   * （v0.9.0 P1-02：右键菜单/托盘可直达指定 Tab；无载荷 = 聊天 Tab）
   */
  openChat: "ui://open-chat",
  /** 隐藏聊天窗口（聊天窗的关闭按钮 = 隐藏，进程仍驻留托盘） */
  hideChat: "ui://hide-chat",
  /** 显示/隐藏宠物窗（托盘菜单也用同一个入口） */
  togglePet: "ui://toggle-pet",
  /** 重置站立计时。单击宠物时发出；v0.7.0 起宠物窗 StandupService 监听 */
  resetStandup: "ui://reset-standup",
  /** 退出应用（右键菜单的「退出」；托盘菜单走 Rust 内部 app.exit，不经事件） */
  quitApp: "ui://quit-app",
  /** 显示站立提醒弹窗（StandupService → Rust 定位到宠物正上方并 show） */
  showAlert: "ui://show-alert",
  /** 用户点击了提醒弹窗（alert 页 → Rust 隐藏弹窗 + StandupService 重置计时） */
  standupAck: "ui://standup-ack",
  /**
   * 显示宠物气泡（v0.9.0 P1-01）。载荷：string（气泡文本，纯字符串）。
   * 聊天窗在「回复完成但用户没看着窗口」时发出 → Rust 定位到宠物正上方、
   * 把载荷原样转发给 bubble 窗（Rust 不解析业务文本）并 show。
   */
  showBubble: "ui://show-bubble",
  /** 隐藏宠物气泡（bubble 页淡出动画结束后自己叫 Rust 藏窗） */
  hideBubble: "ui://hide-bubble",
} as const;

/** 状态层广播事件（纯前端：任意窗口 emit/listen，驱动 PetStateManager 等服务） */
export const STATE_EVENTS = {
  /** 设置情绪状态。载荷：{ state: string; durationSec?: number }（v0.4.0 起 Agent 工具也走它） */
  setMood: "state://set-mood",
  /** 设置系统事件状态（alert/focus/break/sleep…）。载荷同上 */
  setSystem: "state://set-system",
  /** 清除系统状态槽（对应服务结束时调用，如番茄钟停止） */
  clearSystem: "state://clear-system",
  /** PetStateManager 仲裁结果变化。载荷：{ state: string }——宠物窗渲染层订阅 */
  petChanged: "state://pet-changed",
  /** 聊天历史已清空（设置页触发）——ChatTab 收到后重载（空）历史 */
  historyCleared: "state://history-cleared",
  /** 番茄钟阶段/倒计时变化。载荷：{ phase, remainingSec, focusMin?, breakMin? }（v0.7.0） */
  pomodoroChanged: "state://pomodoro-changed",
  /** 在场状态变化。载荷：{ presence: "active"|"away" }（v0.7.0） */
  presenceChanged: "state://presence-changed",
  /** 设置已变更。载荷：{ keys: string[] }——常驻服务监听后重载配置（v0.7.0） */
  settingsChanged: "state://settings-changed",
  /** 提醒列表变化（创建/取消/触发）——番茄钟 Tab 提醒区刷新（v0.7.0） */
  remindersChanged: "state://reminders-changed",
  /** 启动番茄钟（chat 窗工具/UI → 宠物窗 PomodoroService）。载荷：{ minutes?: number } */
  pomodoroStart: "state://pomodoro-start",
  /** 停止番茄钟 */
  pomodoroStop: "state://pomodoro-stop",
  /**
   * 请求重新显示新手引导（设置页「重新显示新手引导」→ 聊天窗 ChatApp）。
   * 引导本体在 ChatApp 内以覆盖层渲染，事件只负责"把它叫出来"（v0.9.0）。
   */
  onboardingRequested: "state://onboarding-requested",
  /**
   * 暂停站立提醒（v0.9.0 P1-03 托盘菜单 / P1-11 弹窗「稍后」共用）。
   * 载荷：{ minutes?: number }（缺省 5 分钟）。收方 StandupService.snooze。
   */
  standupSnooze: "state://standup-snooze",
} as const;

/**
 * Rust → 窗口的转发事件（v0.9.0 P1-01）：Rust 收到 ui://* 后把载荷原样转给
 * 目标窗口。转发链见 lib.rs#show_bubble——Rust 只做路由不存业务文本，
 * 窗口关闭后不残留状态。
 */
export const BRIDGE_EVENTS = {
  /** 气泡文本（lib.rs 收 ui://show-bubble → 转给 bubble 窗）。载荷：string */
  bubbleText: "bubble://text",
  /**
   * 打开聊天窗并切 Tab（lib.rs 收 ui://open-chat → 转给 chat 窗）。
   * 载荷：{ tab?: "chat"|"todos"|"pomodoro"|"settings" }（v0.9.0 P1-02）
   */
  chatOpen: "chat://open",
} as const;

/** 发射一个 UI 事件给 Rust 侧监听器（payload 可选：气泡文本等；Rust 端原样转发或消费） */
export function sendUIEvent(
  event: (typeof UI_EVENTS)[keyof typeof UI_EVENTS],
  payload?: unknown,
): Promise<void> {
  return emit(event, payload);
}

/** 广播一个状态事件（载荷由调用方保证形状，收方 PetStateManager 做校验） */
export function sendStateEvent(
  event: (typeof STATE_EVENTS)[keyof typeof STATE_EVENTS],
  payload?: unknown,
): Promise<void> {
  return emit(event, payload);
}
