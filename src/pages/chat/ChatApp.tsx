import { useCallback } from "react";
import { sendUIEvent, UI_EVENTS } from "@/shared/events";
import { MochiPlaceholder } from "@/shared/components/MochiPlaceholder";
import "./chat.css";

/**
 * 聊天窗（chat）—— v0.1.0 骨架版。
 *
 * v0.3.0 起这里接入：设置 Tab（提供商/Key）与流式对话；
 * v0.4.0 起挂载 Agent 循环。当前仅验证窗口生命周期与「关闭 = 隐藏」。
 */
export function ChatApp() {
  const handleClose = useCallback(() => {
    // 关闭 = 隐藏（进程驻留托盘），窗口管理统一走 Rust
    void sendUIEvent(UI_EVENTS.hideChat);
  }, []);

  return (
    <main className="chat-shell">
      <header className="chat-header">
        <span className="chat-header__title">Mochi 聊天</span>
        <button className="chat-header__close" onClick={handleClose} aria-label="关闭窗口">
          —
        </button>
      </header>

      <section className="chat-body">
        <div className="chat-placeholder">
          <MochiPlaceholder size={96} />
          <h1>你好，我是麻薯 🍡</h1>
          <p>
            聊天功能将在 <strong>v0.3.0</strong> 接入（Provider 抽象 + DeepSeek 流式对话）。
          </p>
          <p className="chat-placeholder__hint">
            双击桌宠可随时打开我；关掉窗口后我会藏在托盘里。
          </p>
        </div>
      </section>
    </main>
  );
}
