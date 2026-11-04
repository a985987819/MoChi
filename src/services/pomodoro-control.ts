import { emit, listen } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";
import type { PomodoroStatus } from "@/services/timers";

/** 只有宿主成功执行后才返回 ok，事件已发送不等于业务已完成。 */
export type PomodoroResult = { ok: true; data: PomodoroStatus } | { ok: false; error: string };

/** UI 与 Agent 共用同一遥控接口，状态读取也向宠物窗请求，避免缓存竞态。 */
export interface PomodoroControl {
  start(minutes?: number): Promise<PomodoroResult>;
  stop(): Promise<PomodoroResult>;
  status(): Promise<PomodoroResult>;
}

/**
 * 先订阅后发命令，用 requestId 区分并发请求；完成/超时均释放监听。
 * 服务启动失败或窗口不可用时显式失败，不能让模型承诺一个没运行的计时器。
 */
function request(event: string, minutes?: number): Promise<PomodoroResult> {
  const requestId = crypto.randomUUID();
  return new Promise(resolve => {
    let off: (() => void) | undefined;
    let settled = false;
    const finish = (result: PomodoroResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      off?.();
      resolve(result);
    };
    const timeout = window.setTimeout(() => finish({
      ok: false, error: "番茄钟服务未响应，请稍后重试或重启麻薯",
    }), 3000);
    void listen<{ requestId: string; result: PomodoroResult }>(STATE_EVENTS.pomodoroResult, e => {
      if (e.payload?.requestId === requestId) finish(e.payload.result);
    }).then(unlisten => {
      off = unlisten;
      if (settled) { off(); return; }
      return emit(event, { requestId, ...(minutes != null ? { minutes } : {}) });
    }).catch(() => finish({ ok: false, error: "番茄钟通信失败，请重试" }));
  });
}

/** 聊天窗无自有计时状态；所有动作都汇入宠物窗的 PomodoroService。 */
export const pomodoroControl: PomodoroControl = {
  start: minutes => request(STATE_EVENTS.pomodoroStart, minutes),
  stop: () => request(STATE_EVENTS.pomodoroStop),
  status: () => request(STATE_EVENTS.pomodoroQuery),
};
