import { listen } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";

/**
 * 原生节拍负责在隐藏时唤醒服务，JS interval 是开发/通信异常时的后备。
 * 同秒的两个来源合并，恢复焦点/可见性则立即复核绝对截止时间；操作系统睡眠中
 * 不会执行代码，恢复后下一节拍补发，不能承诺机器休眠期间弹窗。
 */
export async function subscribeHeartbeat(callback: () => void): Promise<() => void> {
  let disposed = false;
  let lastSecond = -1;
  const run = (force = false) => {
    if (disposed) return;
    const second = Math.floor(Date.now() / 1000);
    if (!force && second === lastSecond) return;
    lastSecond = second;
    callback();
  };
  const wake = () => run(true);
  const timer = window.setInterval(() => run(), 1000);
  window.addEventListener?.("focus", wake);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
  // 即便原生监听安装失败，JS 后备仍可用，调用方不会永久等待就绪。
  const off = await listen(STATE_EVENTS.nativeTick, () => run()).catch(() => () => {});
  return () => {
    disposed = true;
    off();
    window.clearInterval(timer);
    window.removeEventListener?.("focus", wake);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", wake);
  };
}
