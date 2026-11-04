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

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

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
    return false;
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
    return false;
  }
}
