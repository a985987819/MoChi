import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";
import { pomodoroControl } from "@/services/pomodoro-control";
import type { PomodoroStatus } from "@/services/timers";

/**
 * 番茄钟 Tab —— v0.7.0：番茄钟 UI 通道。
 *
 * v0.14.0：到点提醒列表移入新的「提醒」Tab（提醒中心，P1-02）——提醒有了
 * 历史与再次提醒之后是独立的心智单元，本页回归纯粹的计时器职责。
 *
 * 状态来源：PomodoroService（宠物窗）每秒广播 state://pomodoro-changed，
 * 本 Tab 首次挂载请求快照，再订阅广播；启停等待宿主回执（与 Agent 工具同一通道，
 * learning/07 双入口）。倒计时用服务端数字而非本地计时（单一时钟源原则）。
 */

const PHASE_LABEL = { idle: "空闲", focus: "专注中", break: "休息中" } as const;

export function PomodoroTab() {
  const [pomodoro, setPomodoro] = useState<PomodoroStatus>({ phase: "idle", remainingSec: 0, focusMin: 25, awaySec: 0 });
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");

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
    return () => {
      disposed = true;
      void unlistenPomodoro.then(off => off());
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
    </div>
  );
}
