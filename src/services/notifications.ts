/**
 * 系统通知助手 —— tauri-plugin-notification 的统一入口。
 * 权限处理：首次调用时请求授权（Windows 免授权，macOS 弹系统询问）。
 * 调用方（TimerService/ReminderScheduler）先看 settings.notificationsEnabled 开关，
 * 本助手只管"能不能发"。
 */

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

export async function notify(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch (e) {
    console.error("[notify] 发送失败:", e);
  }
}
