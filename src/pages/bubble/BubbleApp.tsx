import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BRIDGE_EVENTS, sendUIEvent, UI_EVENTS } from "@/shared/events";
import "./bubble.css";

/**
 * 宠物气泡（bubble）—— v0.9.0 P1-01：Agent 回复不再只发生在聊天窗。
 *
 * 数据流（Rust 只做路由，不存业务文本——窗口隐藏后不残留状态）：
 *   聊天窗回复完成且用户没看着 → emit ui://show-bubble（载荷=摘要文本）
 *   → Rust 定位到宠物正上方 + 把载荷原样 emit bubble://text 给本窗 + show
 *   → 本窗 listen bubble://text 显示文本，8 秒后淡出 → emit ui://hide-bubble
 *   点击气泡 = 打开聊天窗（气泡的使命就是"把人叫回来"）。
 *
 * 为什么是独立窗口而不是复用 alert：alert 是「需要确认」的模态语义
 * （点击 ack + 超时收尾 + 状态机），气泡是「看一眼就好」的非模态语义，
 * 混用会互相污染生命周期（施工单 P1-01 论证）。
 */

/** 气泡停留时长（毫秒）；淡出动画 300ms（bubble.css transition） */
const BUBBLE_VISIBLE_MS = 8000;
const FADE_OUT_MS = 300;

export function BubbleApp() {
  const [text, setText] = useState<string | null>(null);
  const [fading, setFading] = useState(false);
  const timersRef = useRef<{ fade: number | null; hide: number | null }>({ fade: null, hide: null });

  const clearTimers = useCallback(() => {
    if (timersRef.current.fade != null) window.clearTimeout(timersRef.current.fade);
    if (timersRef.current.hide != null) window.clearTimeout(timersRef.current.hide);
    timersRef.current = { fade: null, hide: null };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>(BRIDGE_EVENTS.bubbleText, e => {
      const t = typeof e.payload === "string" ? e.payload : "";
      if (!t) return;
      clearTimers();
      setText(t); // 重新入场：先以淡出态渲染新文本，下一帧再淡入（连续气泡平滑接力）
      setFading(true);
      requestAnimationFrame(() => setFading(false));
      timersRef.current.fade = window.setTimeout(() => setFading(true), BUBBLE_VISIBLE_MS);
      timersRef.current.hide = window.setTimeout(() => {
        setText(null);
        setFading(false);
        void sendUIEvent(UI_EVENTS.hideBubble); // 淡出完成后让 Rust 藏窗（不留透明壳拦截点击）
      }, BUBBLE_VISIBLE_MS + FADE_OUT_MS);
    });
    return () => {
      clearTimers();
      void unlisten.then(off => off());
    };
  }, [clearTimers]);

  const openChat = useCallback(() => {
    clearTimers();
    setText(null);
    void sendUIEvent(UI_EVENTS.openChat);
    void sendUIEvent(UI_EVENTS.hideBubble);
  }, [clearTimers]);

  return (
    <main className="bubble-shell">
      {text !== null && (
        <div
          className={`bubble ${fading ? "bubble--out" : "bubble--in"}`}
          onClick={openChat}
          role="button"
          aria-label="打开聊天窗"
        >
          {text}
        </div>
      )}
    </main>
  );
}
