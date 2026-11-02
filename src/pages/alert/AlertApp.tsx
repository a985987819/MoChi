import { useCallback } from "react";
import alertImg from "@/assets/pet/alert.svg";
import { sendUIEvent, UI_EVENTS } from "@/shared/events";
import "./alert.css";

/**
 * 提醒弹窗（alert）—— v0.7.0 站立提醒闭环的交互端（learning/08 §4.2）。
 *
 * 生命周期（全在 StandupService 与 Rust 侧）：
 *   到点 → emit ui://show-alert → Rust 定位到宠物正上方并 show
 *   → 用户点击本页任意处 → emit ui://standup-ack → Rust 隐藏弹窗
 *   → StandupService 收到同一事件：stretch 动画 + 重置计时
 * 10 分钟无人点：StandupService 超时自动走同一 ack 路径（先隐藏再重置）。
 */
export function AlertApp() {
  const handleAck = useCallback(() => {
    void sendUIEvent(UI_EVENTS.standupAck);
  }, []);

  return (
    <main className="alert-shell" onClick={handleAck} role="button" aria-label="重置站立计时">
      <div className="alert-card">
        <img className="alert-card__img" src={alertImg} alt="" draggable={false} />
        <h1>该站起来啦！</h1>
        <p>你已经坐了很久，起来活动一下吧</p>
        <p className="alert-card__hint">点击任意处重置计时</p>
      </div>
    </main>
  );
}
