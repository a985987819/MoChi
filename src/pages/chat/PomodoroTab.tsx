import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { sendStateEvent, STATE_EVENTS } from "@/shared/events";
import { reminderStore, type Reminder } from "@/services/reminders";

/**
 * 番茄钟 Tab —— v0.7.0：番茄钟 UI 通道 + 提醒列表。
 *
 * 状态来源：PomodoroService（宠物窗）每秒广播 state://pomodoro-changed，
 * 本 Tab 是纯订阅者——启停发 state://pomodoro-start/stop（与 Agent 工具同一通道，
 * learning/07 双入口）。倒计时用服务端数字而非本地计时（单一时钟源原则）。
 */

interface PomodoroState {
  phase: "idle" | "focus" | "break";
  remainingSec: number;
}

const PHASE_LABEL = { idle: "空闲", focus: "专注中", break: "休息中" } as const;

export function PomodoroTab() {
  const [pomodoro, setPomodoro] = useState<PomodoroState>({ phase: "idle", remainingSec: 0 });
  const [reminders, setReminders] = useState<Reminder[]>([]);

  useEffect(() => {
    const unlistenPomodoro = listen<PomodoroState>(STATE_EVENTS.pomodoroChanged, e => {
      if (e.payload) setPomodoro(e.payload);
    });
    const unlistenReminders = listen(STATE_EVENTS.remindersChanged, () => {
      void reminderStore.listActive().then(setReminders);
    });
    void reminderStore.listActive().then(setReminders);
    return () => {
      void unlistenPomodoro.then(off => off());
      void unlistenReminders.then(off => off());
    };
  }, []);

  // 启停直接发事件（P2-16 清理：曾有构造 PomodoroControl 再 void 掉的死代码——
  // 本 Tab 是纯事件通道，不需要工具层的 Control 形状）

  const start = useCallback(() => {
    void sendStateEvent(STATE_EVENTS.pomodoroStart, {});
  }, []);
  const stop = useCallback(() => {
    void sendStateEvent(STATE_EVENTS.pomodoroStop);
  }, []);
  const cancelReminder = useCallback((id: number) => {
    void reminderStore.cancel(id);
  }, []);

  const mm = String(Math.floor(pomodoro.remainingSec / 60)).padStart(2, "0");
  const ss = String(pomodoro.remainingSec % 60).padStart(2, "0");

  return (
    <div className="pomo-panel">
      <section className={`pomo-card pomo-card--${pomodoro.phase}`}>
        <span className="pomo-phase">{PHASE_LABEL[pomodoro.phase]}</span>
        <span className="pomo-time">{pomodoro.phase === "idle" ? "25:00" : `${mm}:${ss}`}</span>
        {pomodoro.phase === "idle" ? (
          <button className="pomo-btn" onClick={start}>
            开始专注
          </button>
        ) : (
          <button className="pomo-btn pomo-btn--stop" onClick={stop}>
            停止
          </button>
        )}
        <p className="pomo-hint">也可以对麻薯说「来个番茄钟」</p>
      </section>

      <section className="pomo-reminders">
        <span className="pomo-reminders__title">到点提醒（{reminders.length}）</span>
        {reminders.length === 0 && <p className="pomo-hint">对麻薯说「半小时后提醒我喝水」试试</p>}
        {reminders.map(r => (
          <div key={r.id} className="pomo-reminder">
            <span className="pomo-reminder__text">{r.text}</span>
            <span className="pomo-reminder__time">{new Date(r.fireAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            <button onClick={() => cancelReminder(r.id)} aria-label="取消提醒">
              ×
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
