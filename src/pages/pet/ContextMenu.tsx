import { useCallback, useEffect, useRef, useState } from "react";
import { PET_STATES, type PetState, petState } from "@/services/pet-state";
import { sendUIEvent, UI_EVENTS } from "@/shared/events";
import "./context-menu.css";

/**
 * 宠物窗右键菜单（自绘，规格：roadmap v0.2.0 步骤 5）。
 *
 * 设计要点：
 * - **自绘而非系统菜单**：与宠物窗的透明风格一致，且教学上是"HTML 就是 UI"的直接体现；
 * - **菜单必须夹在窗口内**：宠物窗只有 220×260，光标在边缘时菜单会溢出——
 *   打开前测量自身尺寸，把位置夹进视口（clamp）；
 * - 「表情演示」是 v0.2.0 的**验收工具**：无 Agent（v0.4.0）与计时器（v0.7.0）时，
 *   人工触发各状态验证素材回退链/优先级。情绪类走 mood 槽、功能类走 system 槽（8s），
 *   正好能演示"系统状态期间情绪不抢占"（roadmap v0.2.0 验收第 4 条）；
 * - 番茄钟/待办/设置项随各自版本（v0.7/v0.4/v0.3）加入，不提前占位。
 */
export function ContextMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const [demoOpen, setDemoOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  // 夹紧到窗口视口内（菜单预估尺寸：宽 150，展开演示区时高约 240）
  const MENU_W = 150;
  const MENU_H = demoOpen ? 244 : 118;
  const left = Math.max(4, Math.min(x, window.innerWidth - MENU_W - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - MENU_H - 4));

  return (
    <div ref={rootRef} className="ctx-menu" style={{ left, top }} data-tauri-drag-region={false}>
      {item("打开聊天", () => void sendUIEvent(UI_EVENTS.openChat))}
      {item("隐藏麻薯", () => void sendUIEvent(UI_EVENTS.togglePet))}
      <button className="ctx-item" onClick={() => setDemoOpen(v => !v)}>
        表情演示 {demoOpen ? "▾" : "▸"}
      </button>
      {demoOpen && (
        <div className="ctx-demo">
          {PET_STATES.map(s => (
            <DemoButton key={s} state={s} />
          ))}
        </div>
      )}
      <div className="ctx-divider" />
      {item("退出 Mochi", () => void sendUIEvent(UI_EVENTS.quitApp))}
    </div>
  );
}

/** 演示按钮：情绪类(happy/sad)走 mood 槽走默认寿命；功能类走 system 槽 8s，可演示优先级抢占 */
function DemoButton({ state }: { state: PetState }) {
  const onClick = useCallback(() => {
    if (state === "happy" || state === "sad") {
      petState.setMood(state);
    } else {
      petState.setSystem(state, 8);
    }
  }, [state]);
  return (
    <button className="ctx-demo-btn" onClick={onClick} title={state}>
      {state}
    </button>
  );
}
