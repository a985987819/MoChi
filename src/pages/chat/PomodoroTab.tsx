import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";
import { reminderStore, type Reminder } from "@/services/reminders";
import { pomodoroControl } from "@/services/pomodoro-control";
import type { PomodoroStatus } from "@/services/timers";

/**
 * 番茄钟 Tab —— v0.7.0：番茄钟 UI 通道 + 提醒列表。
 *
 * 状态来源：PomodoroService（宠物窗）每秒广播 state://pomodoro-changed，
 * 本 Tab 首次挂载请求快照，再订阅广播；启停等待宿主回执（与 Agent 工具同一通道，
 * learning/07 双入口）。倒计时用服务端数字而非本地计时（单一时钟源原则）。
 */

const PHASE_LABEL = { idle: "空闲", focus: "专注中", break: "休息中" } as const;

/** 周期提醒的中文标签（v0.13.0）：规则本体在 services/recurrence.ts，UI 只负责说人话 */
const REPEAT_LABEL = { daily: "每天", weekdays: "工作日", weekly: "每周" } as const;

export function PomodoroTab() {
  const [pomodoro, setPomodoro] = useState<PomodoroStatus>({ phase: "idle", remainingSec: 0, focusMin: 25, awaySec: 0 });
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [reminders, setReminders] = useState<Reminder[]>([]);

  useEffect(() => {
    let disposed = false;
    const unlistenPomodoro = listen<PomodoroStatus>(STATE_EVENTS.pomodoroChanged, e => {
      if (!disposed && e.payload) setPomodoro(e.payload);
    });
    // 先订阅再查询初始快照：idle 阶段没有每秒广播，不能等到下一次开钟才同步设置。
    void unlistenPomodoro.then(() => pomodoroControl.status()).then(result => {
      if (disposed) return;
      if (result.ok) setPomodoro(result.data);
      else setError(result.error);
      setPending(false);
    });
    const unlistenReminders = listen(STATE_EVENTS.remindersChanged, () => {
      void reminderStore.listActive().then(setReminders);
    });
    void reminderStore.listActive().then(setReminders);
    return () => {
      disposed = true;
      void unlistenPomodoro.then(off => off());
      void unlistenReminders.then(off => off());
    };
  }, []);

  const runCommand = useCallback(async (command: "start" | "stop") => {
    setPending(true);
    setError("");
    const result = await pomodoroControl[command]();
    if (result.ok) setPomodoro(result.data);
    else setError(result.error);
    setPending(false);
  }, []);
  const cancelReminder = useCallback((id: number) => {
    void reminderStore.cancel(id);
  }, []);

  const seconds = pomodoro.phase === "idle" ? pomodoro.focusMin * 60 : pomodoro.remainingSec;
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div className="pomo-panel">
      <section className={`pomo-card pomo-card--${pomodoro.phase}`}>
        <span className="pomo-phase">{PHASE_LABEL[pomodoro.phase]}</span>
        <span className="pomo-time">{`${mm}:${ss}`}</span>
        {pomodoro.phase === "idle" ? (
          <button className="pomo-btn" disabled={pending} onClick={() => void runCommand("start")}>
            开始专注
          </button>
        ) : (
          <button className="pomo-btn pomo-btn--stop" disabled={pending} onClick={() => void runCommand("stop")}>
            停止
          </button>
        )}
        <p className="pomo-hint">也可以对麻薯说「来个番茄钟」</p>
        {/* 离开时长（learning/08 §3 设计兑现）：专注中或结束时如实展示，
            数值为 0 时不渲染——不给"一次都没离开"的专注添加噪音 */}
        {pomodoro.awaySec >= 60 && (
          <p className="pomo-hint">本次专注期间离开约 {Math.round(pomodoro.awaySec / 60)} 分钟</p>
        )}
        {error && <p role="alert">{error}</p>}
      </section>

      <section className="pomo-reminders">
        <span className="pomo-reminders__title">到点提醒（{reminders.length}）</span>
        {reminders.length === 0 && <p className="pomo-hint">对麻薯说「半小时后提醒我喝水」试试</p>}
        {reminders.map(r => (
          <div key={r.id} className="pomo-reminder">
            <span className="pomo-reminder__text">{r.text}</span>
            {/* 数据防御：DB 里的 fireAt 理论上是数字，脏数据（NULL/NaN）不能渲染成
                "Invalid Date" 占一整行——降级为不显示时间 */}
            <span className="pomo-reminder__time">
              {r.repeat !== "none" && (
                <span className="pomo-reminder__repeat">{REPEAT_LABEL[r.repeat]}</span>
              )}
              {Number.isFinite(r.fireAt) ? new Date(r.fireAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
            </span>
            <button onClick={() => cancelReminder(r.id)} aria-label="取消提醒">
              ×
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
