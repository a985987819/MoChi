import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PET_STATES, type PetState, petState } from "@/services/pet-state";
import { todoService } from "@/services/todos";
import { pomodoroService, standupService } from "@/services/timers";
import { sendStateEvent, sendUIEvent, STATE_EVENTS, UI_EVENTS } from "@/shared/events";
import { clampMenuPosition } from "./menu-position";
import "./context-menu.css";

/** 窗口通信异常不应变成未处理 Promise，动作由原生宿主统一执行。 */
function requestUI(
  event: Parameters<typeof sendUIEvent>[0],
  payload?: unknown,
): void {
  void sendUIEvent(event, payload).catch(error => console.error("[pet-menu] 窗口操作失败", error));
}

/**
 * 宠物窗右键菜单（自绘，规格：roadmap v0.2.0 步骤 5；P1-02 信息密度改版）。
 *
 * 设计要点：
 * - **自绘而非系统菜单**：与宠物窗的透明风格一致，且教学上是"HTML 就是 UI"的直接体现；
 * - **夹紧用实测尺寸**（两侧同时修复，取 menu-position.ts 纯函数版）：旧版用
 *   MENU_W/MENU_H 常量预估，菜单项变多后必然溢出。useLayoutEffect 里
 *   getBoundingClientRect 测真实尺寸再 clamp——layoutEffect 在 paint 之前跑，
 *   用户看不到溢出帧；
 * - **指针事件就地截断**（v0.8.2 手势系统配套）：菜单浮在宠物手势层之上，
 *   pointer/click 不冒泡到 PetApp 的手势控制器，菜单里的连点不会被误判成
 *   单击宠物/拖动；
 * - **状态行是活的**：番茄钟/站立提醒每秒重读服务状态（菜单本来就开在宠物窗，
 *   Service 单例就地可读，无需跨窗口事件）；
 * - 「调试 → 表情演示」收进子菜单：它是素材回退链的验收工具（roadmap v0.2.0），
 *   保留但不再占据一级菜单——用户菜单该以任务为导向。
 */
export function ContextMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const [demoOpen, setDemoOpen] = useState(false);
  const [todoCount, setTodoCount] = useState<number | null>(null);
  const [pomo, setPomo] = useState(pomodoroService.status());
  const [standupSec, setStandupSec] = useState(standupService.remainingSec());
  const rootRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 4, top: 4 });

  // 点击菜单外 / Escape 关闭：document 级监听（菜单打开期间）
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // 待办数：等宠物窗实例完成 SQLite 加载（宠物窗平时没人碰 todoService，
  // ready 在此首次推进）——打开菜单的瞬间读到的是当前真实数量
  useEffect(() => {
    let mounted = true;
    void todoService.ready.then(() => {
      if (mounted) setTodoCount(todoService.list().length);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // 番茄钟 + 站立提醒剩余时间：每秒重读（菜单生命周期短，轮询比订阅简单可靠）
  useEffect(() => {
    const refresh = () => {
      setPomo(pomodoroService.status());
      setStandupSec(standupService.remainingSec());
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 夹紧到窗口视口内：用实测尺寸，依赖 demoOpen——子菜单展开后高度变化要重新夹
  useLayoutEffect(() => {
    const size = rootRef.current?.getBoundingClientRect();
    if (size) setPosition(clampMenuPosition(x, y, size.width, size.height, window.innerWidth, window.innerHeight));
  }, [x, y, demoOpen]);

  const item = useCallback(
    (label: string, action: () => void) => (
      <button
        key={label}
        className="ctx-item"
        onClick={() => {
          action();
          onClose();
        }}
      >
        {label}
      </button>
    ),
    [onClose],
  );

  const standupLabel =
    standupSec === 0
      ? "站立提醒 · 等你点击提醒窗"
      : standupSec < 60
        ? "站立提醒 · 还剩不到 1 分钟"
        : `站立提醒 · 还剩 ${Math.ceil(standupSec / 60)} 分钟`;

  return (
    <div
      ref={rootRef}
      className="ctx-menu"
      style={position}
      data-tauri-drag-region={false}
      onPointerDown={e => e.stopPropagation()}
      onPointerUp={e => e.stopPropagation()}
      onPointerMove={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
    >
      {item("打开聊天", () => requestUI(UI_EVENTS.openChat))}
      {item(todoCount === 0 ? "待办" : `待办（${todoCount ?? "…"}）`, () =>
        requestUI(UI_EVENTS.openChat, { tab: "todos" }),
      )}
      {pomo.phase === "idle"
        ? item("开始番茄钟", () => void sendStateEvent(STATE_EVENTS.pomodoroStart, {}))
        : item(
            pomo.phase === "focus"
              ? `番茄钟 · 专注中 ${formatCountdown(pomo.remainingSec)}`
              : `番茄钟 · 休息中 ${formatCountdown(pomo.remainingSec)}`,
            () => void sendStateEvent(STATE_EVENTS.pomodoroStop),
          )}
      {item(standupLabel, () => requestUI(UI_EVENTS.resetStandup))}
      <div className="ctx-divider" />
      {item("设置…", () => requestUI(UI_EVENTS.openChat, { tab: "settings" }))}
      {item("暂停提醒 1 小时", () => standupService.snooze(60))}
      <div className="ctx-divider" />
      {item("隐藏麻薯", () => requestUI(UI_EVENTS.togglePet))}
      <button className="ctx-item" onClick={() => setDemoOpen(v => !v)}>
        调试 {demoOpen ? "▾" : "▸"}
      </button>
      {demoOpen && (
        <div className="ctx-demo">
          {PET_STATES.map(s => (
            <DemoButton key={s} state={s} />
          ))}
        </div>
      )}
      <div className="ctx-divider" />
      {item("退出 Mochi", () => requestUI(UI_EVENTS.quitApp))}
      {/* 手势备忘（P1-10）：不可点的静态行——三个手势没有任何视觉暗示，
          菜单每次打开都在，是最便宜的"持续提示位" */}
      <div className="ctx-hint">拖动移动 · 单击重置站立 · 双击聊天</div>
    </div>
  );
}

/** 番茄钟倒计时 mm:ss（菜单行内展示） */
function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 演示按钮：情绪类(happy/sad)走 mood 槽走默认寿命；功能类走 system 槽 8s，
 * 可演示优先级抢占。owner 标 "demo"：与真实服务（standup/pomodoro）的槽互不干扰，
 * 演示到期只清演示自己的状态。
 */
function DemoButton({ state }: { state: PetState }) {
  const onClick = useCallback(() => {
    if (state === "happy" || state === "sad") {
      petState.setMood(state);
    } else {
      petState.setSystem(state, 8, "demo");
    }
  }, [state]);
  return (
    <button className="ctx-demo-btn" onClick={onClick} title={state}>
      {state}
    </button>
  );
}
