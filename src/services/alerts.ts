import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";

/** 每条可见提醒携带所有者 id，关闭它不会误确认另一个服务的提醒。 */
export interface AppAlert {
  id: string;
  kind: "standup" | "reminder" | "pomodoro";
  title: string;
  body: string;
}

/**
 * 原生队列接受（首条成功显示、其余排队）后才成功，失败交由调用服务重试。
 * 系统通知可被关闭/拒绝，应用内弹窗作为独立交付通道，不依赖通知权限。
 */
export function showAppAlert(alert: AppAlert): Promise<void> {
  return invoke("show_app_alert", { alert });
}

/** 自动收尾只移除指定 id，不触发用户确认或重置其他服务的计时。 */
export function dismissAppAlert(id: string): Promise<void> {
  return invoke("dismiss_app_alert", { id });
}

/** 初次载入时读取原生队头，弥补 WebView 尚未订阅期间丢失的事件。 */
export function getAppAlert(): Promise<AppAlert | null> {
  return invoke("get_app_alert");
}

/** 确认只针对渲染中的 id，原生端再次校验，抵御快速连点与旧画面回调。 */
export function acknowledgeAppAlert(id: string): Promise<void> {
  return invoke("ack_app_alert", { id });
}

/**
 * 先监听再拉取快照，并拒绝用旧快照覆盖期间收到的新队头。
 * 返回清理函数后立即可解绑，即使原生快照仍在路上也不会向已卸载页面写状态。
 */
export async function subscribeAppAlerts(
  onChange: (alert: AppAlert | null) => void,
  onError: () => void,
): Promise<() => void> {
  let disposed = false;
  let changes = 0;
  const off = await listen<AppAlert | null>(STATE_EVENTS.appAlertChanged, event => {
    changes += 1;
    if (!disposed) onChange(event.payload);
  });
  const observed = changes;
  void getAppAlert().then(current => {
    if (!disposed && changes === observed) onChange(current);
  }).catch(() => { if (!disposed) onError(); });
  return () => { disposed = true; off(); };
}
