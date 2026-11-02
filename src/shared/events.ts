import { emit } from "@tauri-apps/api/event";

/**
 * UI → Rust 的单向事件约定。
 *
 * 设计原则：窗口的显示/隐藏/位置等系统级操作统一由 Rust 侧管理（见 src-tauri/src/lib.rs），
 * 前端只负责「发事件」。好处：
 * 1. 权限收敛——前端不需要 window 控制类 capability，攻击面更小；
 * 2. 行为一致——无论从托盘、宠物窗还是聊天窗触发，窗口逻辑只有一份；
 * 3. 好测试——前端 mock emit、Rust 单独验证即可。
 *
 * 命名规范：`ui://<动作>`，全小写连字符。
 */
export const UI_EVENTS = {
  /** 打开（显示并聚焦）聊天窗口 */
  openChat: "ui://open-chat",
  /** 隐藏聊天窗口（聊天窗的关闭按钮 = 隐藏，进程仍驻留托盘） */
  hideChat: "ui://hide-chat",
  /** 显示/隐藏宠物窗（托盘菜单也用同一个入口） */
  togglePet: "ui://toggle-pet",
} as const;

/** 发射一个 UI 事件给 Rust 侧监听器 */
export function sendUIEvent(event: (typeof UI_EVENTS)[keyof typeof UI_EVENTS]): Promise<void> {
  return emit(event);
}
