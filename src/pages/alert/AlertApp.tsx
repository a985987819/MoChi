import { useCallback } from "react";
import alertImg from "@/assets/pet/alert.svg";
import { sendStateEvent, sendUIEvent, STATE_EVENTS, UI_EVENTS } from "@/shared/events";
import "./alert.css";

/**
 * 提醒弹窗（alert）—— v0.7.0 站立提醒闭环的交互端（learning/08 §4.2）。
 *
 * 生命周期（全在 StandupService 与 Rust 侧）：
 *   到点 → emit ui://show-alert → Rust 定位到宠物正上方并 show
 *   → 用户选择：
 *      · 点卡片任意处 / 「起来活动」→ emit ui://standup-ack
 *        → Rust 隐藏弹窗 + StandupService：stretch 动画 + 重置计时
 *      · 「稍后 5 分钟」（v0.9.0 P1-11）→ emit state://standup-snooze {minutes:5}
 *        + ui://hide-alert（只藏窗，无 ack 副作用）
 *        → StandupService.snooze：deadline = now+5min，宠物回 idle，5 分钟后再弹
 * 10 分钟无人点：StandupService 超时自动走 ack 路径（先隐藏再重置）。
 */
export function AlertApp() {
  const handleAck = useCallback(() => {
    void sendUIEvent(UI_EVENTS.standupAck);
  }, []);

  const handleSnooze = useCallback(() => {
    void sendStateEvent(STATE_EVENTS.standupSnooze, { minutes: 5 });
    void sendUIEvent(UI_EVENTS.hideAlert);
  }, []);

  return (
    <main className="alert-shell" onClick={handleAck} role="button" aria-label="重置站立计时">
      <div className="alert-card">
        <img className="alert-card__img" src={alertImg} alt="" draggable={false} />
        <h1>该站起来啦！</h1>
        <p>你已经坐了很久，起来活动一下吧</p>
        <div className="alert-card__actions">
          <button className="alert-card__btn alert-card__btn--primary" onClick={handleAck}>
            起来活动
          </button>
          <button
            className="alert-card__btn"
            onClick={e => {
              e.stopPropagation(); // 别触发整卡 ack：稍后 ≠ 重置
              handleSnooze();
            }}
          >
            稍后 5 分钟
          </button>
        </div>
        <p className="alert-card__hint">点击卡片任意处 = 立即重置计时</p>
      </div>
    </main>
  );
}
