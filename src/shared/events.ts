import { emit } from "@tauri-apps/api/event";

/**
 * 本文件是 Mochi 的**通信协议常量表**，与 `src-tauri/src/lib.rs` 的 `EVT_*` 常量一一对应。
 * 改名必须两侧同步。命名规范：
 * - `ui://<动作>`    —— UI 发起，请求 Rust 做系统操作；
 * - `state://<变化>` —— 服务/状态层广播，供任意窗口订阅（纯前端跨窗口，不经 Rust）。
 *
 * v0.9.0 合并说明：原独立气泡窗（bubble.html）已并入宠物窗内的 PetBubble 组件
 * （与 v0.8.2 的单击暖心气泡共用一套展示），`bubble://text` 桥事件随之移除；
 * `ui://show-bubble` 保留，由宠物窗直接订阅。
 */

/** UI → Rust 事件（Rust 侧 lib.rs 监听） */
export const UI_EVENTS = {
  /**
   * 打开（显示并聚焦）聊天窗口。载荷：{ tab?: "chat"|"todos"|"pomodoro"|"settings" }
   * （v0.9.0 P1-02：右键菜单可直达指定 Tab；无载荷 = 聊天 Tab。Rust 把载荷原样
   * 转发给 chat 窗的 chat://open 桥事件）
   */
  openChat: "ui://open-chat",
  /** 隐藏聊天窗口（聊天窗的关闭按钮 = 隐藏，进程仍驻留托盘） */
  hideChat: "ui://hide-chat",
  /** 显示/隐藏宠物窗（托盘菜单也用同一个入口） */
  togglePet: "ui://toggle-pet",
  /** 手势移动超过阈值后请求 Rust 开始系统拖动，单击/双击不被按下抢走（v0.8.2） */
  dragPet: "ui://drag-pet",
  /** 重置站立计时。单击宠物时发出；v0.7.0 起宠物窗 StandupService 监听 */
  resetStandup: "ui://reset-standup",
  /** 退出应用（右键菜单的「退出」；托盘菜单走 Rust 内部 app.exit，不经事件） */
  quitApp: "ui://quit-app",
  /** 显示站立提醒弹窗（旧入口兼容；v0.8.2 起正文提醒走 show_app_alert 原生队列） */
  showAlert: "ui://show-alert",
  /**
   * 隐藏提醒弹窗（旧入口兼容）：收尾不等于确认——不触发 stretch/重置副作用
   * （P1-11「稍后」语义）。新代码用 dismiss_app_alert 命令按 id 移除。
   */
  hideAlert: "ui://hide-alert",
  /** 用户点击了提醒弹窗（旧入口兼容；新代码走 ack_app_alert 命令 + app-alert-acked 广播） */
  standupAck: "ui://standup-ack",
  /**
   * 显示宠物气泡（v0.9.0 P1-01）。载荷：string（气泡文本，纯字符串）。
   * 聊天窗在「回复完成但用户没看着窗口」时发出 → 宠物窗直接订阅本事件，
   * 用头顶 PetBubble 展示（7 秒淡出）。
   */
  showBubble: "ui://show-bubble",
} as const;

/** 状态层广播事件（纯前端：任意窗口 emit/listen，驱动 PetStateManager 等服务） */
export const STATE_EVENTS = {
  /** 原生线程每秒发送到 pet 窗；隐藏窗口时不依赖 WebView setInterval（v0.8.2） */
  nativeTick: "state://native-tick",
  /** 原生提醒队列当前队头变化。载荷：AppAlert | null（v0.8.2） */
  appAlertChanged: "state://app-alert-changed",
  /** 用户确认了匹配 id 的提醒。载荷：{ id, kind }（v0.8.2） */
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
  /** 番茄钟阶段/倒计时变化。载荷：{ phase, remainingSec, focusMin }（v0.7.0；focusMin v0.8.2 起） */
  pomodoroChanged: "state://pomodoro-changed",
  /** 在场状态变化。载荷：{ presence: "active"|"away" }（v0.7.0） */
  presenceChanged: "state://presence-changed",
  /** 设置已变更。载荷：{ keys: string[] }——常驻服务监听后重载配置（v0.7.0） */
  settingsChanged: "state://settings-changed",
  /** 提醒列表变化（创建/取消/触发）——番茄钟 Tab 提醒区刷新（v0.7.0） */
  remindersChanged: "state://reminders-changed",
  /** 启动番茄钟（chat 窗工具/UI → 宠物窗 PomodoroService）。载荷：{ minutes?, requestId? } */
  pomodoroStart: "state://pomodoro-start",
  /** 停止番茄钟。载荷：{ requestId? } */
  pomodoroStop: "state://pomodoro-stop",
  /** 查询番茄钟权威快照；与启停一起携带 requestId，避免依赖上一秒的缓存（v0.8.2） */
  pomodoroQuery: "state://pomodoro-query",
  /** 番茄钟宿主回执：{ requestId, result: { ok, data?/error? } }（v0.8.2） */
  pomodoroResult: "state://pomodoro-result",
  /**
   * 请求重新显示新手引导（设置页「重新显示新手引导」→ 聊天窗 ChatApp）。
   * 引导本体在 ChatApp 内以覆盖层渲染，事件只负责"把它叫出来"（v0.9.0）。
   */
  onboardingRequested: "state://onboarding-requested",
  /**
   * 暂停站立提醒（v0.9.0 P1-03 托盘菜单「暂停 1 小时」/ P1-11 弹窗「稍后 5 分钟」共用）。
   * 载荷：{ minutes?: number }（缺省 5 分钟）。收方 StandupService.snooze。
   */
  standupSnooze: "state://standup-snooze",
  /**
   * 全局快捷键开关（v0.9.0 P1-13，前端 → Rust）。载荷：{ enabled: boolean }。
   * Rust 收到后注册/注销系统级快捷键（默认 Ctrl/Cmd+Shift+M 开聊天窗）。
   */
  shortcutChanged: "state://shortcut-changed",
  /**
   * 快捷键注册结果（Rust → 前端）。载荷：{ enabled: boolean; registered: boolean }。
   * registered=false 且 enabled=true = 键位被其他软件占用——设置页提示。
   */
  shortcutState: "state://shortcut-state",
  /**
   * 开机自启开关（v0.9.0 P1-14，前端 → Rust）。载荷：{ enabled: boolean }。
   * Rust 收到后 enable/disable 系统自启项（Win 注册表 Run / mac LaunchAgent）。
   */
  autostartChanged: "state://autostart-changed",
  /**
   * 宠物大小档位（v0.9.0 P1-15，前端 → Rust + 宠物窗）。
   * 载荷：{ scale: number }（0.8 | 1 | 1.2）。Rust 改窗口尺寸（右下角锚点 +
   * 屏内 clamp）；宠物窗写 CSS 变量 --pet-scale 缩放形象。
   */
  petScaleChanged: "state://pet-scale-changed",
} as const;

/**
 * Rust → 窗口的转发事件（v0.9.0 P1-02）：Rust 收到 ui://open-chat 后把 {tab} 载荷
 * 原样转给 chat 窗。转发链见 lib.rs 的 EVT_OPEN_CHAT 监听——Rust 只做路由不存业务载荷。
 */
export const BRIDGE_EVENTS = {
  /** 打开聊天窗并切 Tab（lib.rs 收 ui://open-chat → 转给 chat 窗）。载荷：{ tab?: string } */
  chatOpen: "chat://open",
} as const;

/** 发射一个 UI 事件给 Rust 侧监听器（payload 可选：气泡文本、{tab} 等；Rust 端原样转发或消费） */
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
