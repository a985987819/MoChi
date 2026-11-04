import { useCallback, useEffect, useRef, useState } from "react";
import alertImg from "@/assets/pet/alert.svg";
import { acknowledgeAppAlert, subscribeAppAlerts, type AppAlert } from "@/services/alerts";
import { AlertActionGate, type AlertAction } from "./action-gate";
import "./alert.css";

/**
 * 所有到点提醒共享一个原生队列，但显示动态内容，并且仅确认当前 id。
 * 先订阅后取快照；拉取期间如有新事件，快照不能覆盖较新的画面。
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

  return (
    <main className="alert-shell" onClick={event => void handleAck({ clickCount: event.detail })} role="button" tabIndex={0}
      aria-label={alert ? `确认提醒：${alert.title}` : "提醒"} aria-disabled={pending}
      onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void handleAck({ repeat: event.repeat });
        }
      }}>
      <div className="alert-card">
        <img className="alert-card__img" src={alertImg} alt="" draggable={false} />
        <h1>{alert?.title ?? "提醒"}</h1>
        <p className="alert-card__body">{alert?.body ?? "正在读取提醒…"}</p>
        <p className="alert-card__hint">{pending ? "正在确认…" : "点击或按 Enter 确认"}</p>
        {error && <p role="alert">{error}</p>}
      </div>
    </main>
  );
}
