import { emit } from "@tauri-apps/api/event";

/**
 * 本文件是 Mochi 的**通信协议常量表**，与 `src-tauri/src/lib.rs` 的 `EVT_*` 常量一一对应。
 * 改名必须两侧同步。命名规范：
 * - `ui://<动作>`    —— UI 发起，请求 Rust 做系统操作；
 * - `state://<变化>` —— 服务/状态层广播，供任意窗口订阅（纯前端跨窗口，不经 Rust）。
 */

/** UI → Rust 事件（Rust 侧 lib.rs 监听） */
export const UI_EVENTS = {
  /** 打开（显示并聚焦）聊天窗口 */
  openChat: "ui://open-chat",
  /** 隐藏聊天窗口（聊天窗的关闭按钮 = 隐藏，进程仍驻留托盘） */
  hideChat: "ui://hide-chat",
  /** 显示/隐藏宠物窗（托盘菜单也用同一个入口） */
  togglePet: "ui://toggle-pet",
  /** 重置站立计时。单击宠物时发出；Rust 侧自 v0.7.0 起由 StandupService 监听，
   *  此前无监听者、静默丢弃——先固化交互契约，避免 v0.7.0 改前端 */
  resetStandup: "ui://reset-standup",
  /** 退出应用（右键菜单的「退出」；托盘菜单走 Rust 内部 app.exit，不经事件） */
  quitApp: "ui://quit-app",
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
} as const;

/** 发射一个 UI 事件给 Rust 侧监听器 */
export function sendUIEvent(event: (typeof UI_EVENTS)[keyof typeof UI_EVENTS]): Promise<void> {
  return emit(event);
}

/** 广播一个状态事件（载荷由调用方保证形状，收方 PetStateManager 做校验） */
export function sendStateEvent(
  event: (typeof STATE_EVENTS)[keyof typeof STATE_EVENTS],
  payload?: unknown,
): Promise<void> {
  return emit(event, payload);
}
