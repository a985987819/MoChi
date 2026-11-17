/**
 * 系统通知助手 —— tauri-plugin-notification 的统一入口。
 * 调用方（TimerService/ReminderScheduler）先看 settings.notificationsEnabled 开关，
 * 本助手只管"能不能发"。
 *
 * 权限策略（v0.9.0 P0-03）：授权申请**集中在启动时预热**
 * （pet/main.tsx 调 warmupNotificationPermission）——macOS 首次会弹系统询问，
 * 放启动时是"预期内的打断"；到点提醒的瞬间才弹授权框是"预期外的打断"。
 * notify 只查权限、发通知、报告成败（返回 boolean），失败不再静默。
 */

import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { sendUIEvent, UI_EVENTS } from "@/shared/events";
import { logError } from "@/services/log";

/**
 * 发一条系统通知。
 * @returns 是否真的发出去了（权限缺失/插件异常都算失败）——调用方可以据此
 *          降级（例如提醒类事件同时会用宠物 alert 状态兜底，见 learning/08）
 */
export async function notify(title: string, body: string): Promise<boolean> {
  try {
    if (!(await isPermissionGranted())) return false;
    sendNotification({ title, body });
    return true;
  } catch (e) {
    console.error("[notify] 发送失败:", e);
    logError("notify", `通知发送失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * 通知标题 → 聊天窗 Tab 的路由表（P1-02 / v0.14.0）。
 *
 * 点系统通知应该"去处理这件事"：到点提醒去提醒中心、待办到期去待办列表。
 * 插件的 ActionPerformed 携带通知自身数据（Windows/macOS 都回报），用**标题前缀**
 * 识别类型——标题是应用自己定的稳定常量，比给每条通知配 action type（移动端机制，
 * 桌面端没有按钮就不触发）简单且跨平台一致。没匹配上的（番茄钟/站立）回聊天 Tab。
 */
const TAP_TAB_BY_TITLE: Array<{ prefix: string; tab: "reminders" | "todos" }> = [
  { prefix: "⏰", tab: "reminders" },
  { prefix: "📌", tab: "todos" },
];

/**
 * 注册「点通知 → 打开聊天窗」路由（P1-02 / v0.14.0），在**宠物窗**启动时调用。
 *
 * 为什么必须在宠物窗常驻注册：插件的桌面实现只对「监听器存在期间发出的通知」
 * 回报点击（见插件 desktop.rs —— "notifications shown while a listener existed"），
 * 宠物窗是生命周期最长的窗口，通知也全部从这里发出。点击经 Rust 的 show_chat
 * 聚焦聊天窗，再由 open-chat 的 {tab} 载荷直达对应 Tab——整条链路复用既有协议，
 * 不引入第二个通知插件。
 *
 * 平台限制（写进版本文档）：Windows 只有 toast **还在屏幕上**时点击才回报，
 * 进了操作中心的历史通知点了没反应——这是系统行为，应用内提醒中心兜底。
 *
 * 失败静默：路由是增强不是主通道（弹窗/提醒中心本来就是可用的）。
 */
export async function registerNotificationTapRouting(): Promise<void> {
  try {
    const listener = await onAction(event => {
      const title = event.notification?.title ?? "";
      const match = TAP_TAB_BY_TITLE.find(entry => title.startsWith(entry.prefix));
      void sendUIEvent(UI_EVENTS.openChat, match ? { tab: match.tab } : undefined).catch(() => undefined);
    });
    // HMR：热更新时卸掉旧监听，避免一次点击触发多次 openChat。
    if (import.meta.hot) import.meta.hot.dispose(() => void listener.unregister());
  } catch (e) {
    console.error("[notify] 通知点击路由注册失败（点击通知将无响应）:", e);
    logError("notify", `通知点击路由注册失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 启动时的权限预热：已授权直接过；未授权则请求（macOS 弹系统询问框，
 * Windows 恒返回已授权，预热是幂等的）。失败不抛——权限状态由设置页展示。
 */
export async function warmupNotificationPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch (e) {
    console.error("[notify] 权限预热失败:", e);
    logError("notify", `通知权限预热失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
