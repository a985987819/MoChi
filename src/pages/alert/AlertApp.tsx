import { useCallback, useEffect, useRef, useState } from "react";
import alertImg from "@/assets/pet/alert.svg";
import { acknowledgeAppAlert, dismissAppAlert, subscribeAppAlerts, type AppAlert } from "@/services/alerts";
import { sendStateEvent, STATE_EVENTS } from "@/shared/events";
import { AlertActionGate, type AlertAction } from "./action-gate";
import "./alert.css";

/**
 * 所有到点提醒共享一个原生队列，但显示动态内容，并且仅确认当前 id。
 * 先订阅后取快照；拉取期间如有新事件，快照不能覆盖较新的画面。
 *
 * 两条用户出口（合并说明）：
 * - 确认（起来活动/点卡片/Enter）→ ack_app_alert → stretch 动画 + 计时重置；
 * - 稍后（仅站立提醒，v0.9.0 P1-11）→ dismiss_app_alert（无 ack 副作用）
 *   + state://standup-snooze {minutes:5} → StandupService.snooze 推迟 5 分钟。
 *   「稍后」≠「确认」：宠物不播 stretch、站立计时从 now+5min 重新起算。
 */
export function AlertApp() {
  const [alert, setAlert] = useState<AppAlert | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const actionGate = useRef(new AlertActionGate());

  useEffect(() => {
    let disposed = false;
    const listening = subscribeAppAlerts(current => {
      if (disposed) return;
      setAlert(current);
      setError("");
      setPending(false);
    }, () => { if (!disposed) setError("提醒加载失败，请稍后重试"); });
    void listening.catch(() => { if (!disposed) setError("提醒监听失败，请重新打开应用"); });
    return () => { disposed = true; void listening.then(off => off()).catch(() => undefined); };
  }, []);

  const handleAck = useCallback(async (action: AlertAction = {}) => {
    if (!alert || !actionGate.current.tryBegin(action)) return;
    setPending(true);
    setError("");
    try {
      await acknowledgeAppAlert(alert.id);
    } catch {
      setError("暂时无法关闭，请重试");
    } finally {
      actionGate.current.finish();
      setPending(false);
    }
  }, [alert]);

  /** 稍后 5 分钟（P1-11）：收尾不确认；与确认共用同一道手势门，防止连点穿透。 */
  const handleSnooze = useCallback(async () => {
    if (!alert || alert.kind !== "standup" || !actionGate.current.tryBegin({})) return;
    setPending(true);
    setError("");
    try {
      void sendStateEvent(STATE_EVENTS.standupSnooze, { minutes: 5 });
      await dismissAppAlert(alert.id);
    } catch {
      setError("暂时无法收起，请重试");
    } finally {
      actionGate.current.finish();
      setPending(false);
    }
  }, [alert]);

  return (
    <main className="alert-shell" onClick={event => void handleAck({ clickCount: event.detail })} role="button" tabIndex={0}
      aria-label={alert ? `确认提醒：${alert.title}` : "提醒"} aria-disabled={pending}
      onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void handleAck({ repeat: event.repeat });
        }
      }}>
      {/* key=alert.id：窗口隐藏不销毁，CSS 入场动画只在首次挂载播过一次——
          按 id 重挂卡片让每条新提醒都重播 pop（卡片节点极小，重挂零成本） */}
      <div key={alert?.id ?? "empty"} className="alert-card">
        <img className="alert-card__img" src={alertImg} alt="" draggable={false} />
        <h1>{alert?.title ?? "提醒"}</h1>
        <p className="alert-card__body">{alert?.body ?? "正在读取提醒…"}</p>
        {alert?.kind === "standup" && (
          <div className="alert-card__actions" onClick={e => e.stopPropagation()}>
            <button
              className="alert-card__btn alert-card__btn--primary"
              disabled={pending}
              onClick={() => void handleAck({})}
            >
              起来活动
            </button>
            <button className="alert-card__btn" disabled={pending} onClick={() => void handleSnooze()}>
              稍后 5 分钟
            </button>
          </div>
        )}
        <p className="alert-card__hint">{pending ? "正在处理…" : alert?.kind === "standup" ? "点击卡片任意处 = 立即重置计时" : "点击或按 Enter 确认"}</p>
        {error && <p role="alert">{error}</p>}
      </div>
    </main>
  );
}
