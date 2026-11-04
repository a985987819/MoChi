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
  /** 手势移动超过阈值后请求 Rust 开始系统拖动，点击不进入拖动。 */
  dragPet: "ui://drag-pet",
  /** 重置站立计时。单击宠物时发出；v0.7.0 起宠物窗 StandupService 监听 */
  resetStandup: "ui://reset-standup",
  /** 退出应用（右键菜单的「退出」；托盘菜单走 Rust 内部 app.exit，不经事件） */
  quitApp: "ui://quit-app",
  /** 显示站立提醒弹窗（StandupService → Rust 定位到宠物正上方并 show） */
  showAlert: "ui://show-alert",
  /** 提醒服务收尾（超时/单击宠物/修改间隔）也必须隐藏原生弹窗。 */
  hideAlert: "ui://hide-alert",
  /** 用户点击了提醒弹窗（alert 页 → Rust 隐藏弹窗 + StandupService 重置计时） */
  standupAck: "ui://standup-ack",
} as const;

/** 状态层广播事件（纯前端：任意窗口 emit/listen，驱动 PetStateManager 等服务） */
export const STATE_EVENTS = {
  /** 原生线程每秒发送到 pet，隐藏窗口时不依赖 WebView setInterval。 */
  nativeTick: "state://native-tick",
  /** Rust 队列当前提醒变更，载荷 AppAlert|null。 */
  appAlertChanged: "state://app-alert-changed",
  /** 用户确认了匹配 id 的提醒，载荷 { id, kind }。 */
  appAlertAcked: "state://app-alert-acked",
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
  /** 查询权威快照；与启停一起携带 requestId，避免依赖上一秒的缓存。 */
  pomodoroQuery: "state://pomodoro-query",
  /** 宿主回执：{ requestId, result: { ok, data?/error? } }。 */
  pomodoroResult: "state://pomodoro-result",
  /**
   * 请求重新显示新手引导（设置页「重新显示新手引导」→ 聊天窗 ChatApp）。
   * 引导本体在 ChatApp 内以覆盖层渲染，事件只负责"把它叫出来"（v0.9.0）。
   */
  onboardingRequested: "state://onboarding-requested",
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
