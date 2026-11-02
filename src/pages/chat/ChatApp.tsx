import { useCallback, useState } from "react";
import { ChatTab } from "./ChatTab";
import { SettingsTab } from "./SettingsTab";
import { sendUIEvent, UI_EVENTS } from "@/shared/events";
import { MochiPlaceholder } from "@/shared/components/MochiPlaceholder";
import "./chat.css";

/**
 * 聊天窗（chat）—— v0.3.0：自绘标题栏 + Tab（聊天/设置）。
 *
 * v0.1.0 版本记录预告过：做设置 UI 时把系统标题栏换成自绘（decorations:false）。
 * 标题栏 = 拖动区 + 关闭按钮（emit ui://hide-chat，关闭=隐藏）。
 * Tab 结构为后续功能预留：番茄钟（v0.7.0）、待办（v0.4.0）。
 */
type TabId = "chat" | "settings";

export function ChatApp() {
  const [tab, setTab] = useState<TabId>("chat");

  const handleClose = useCallback(() => {
    void sendUIEvent(UI_EVENTS.hideChat);
  }, []);

  return (
    <main className="chat-shell">
      {/* 自绘标题栏：整体是拖动区，按钮 stopPropagation 保住点击 */}
      <header className="chat-titlebar" data-tauri-drag-region>
        <span className="chat-titlebar__title" data-tauri-drag-region>
          <MochiPlaceholder size={18} />
          Mochi 聊天
        </span>
        <nav className="chat-tabs" onClick={e => e.stopPropagation()}>
          <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
            聊天
          </TabButton>
          <TabButton active={tab === "settings"} onClick={() => setTab("settings")}>
            设置
          </TabButton>
        </nav>
        <button className="chat-titlebar__close" onClick={handleClose} aria-label="关闭窗口">
          ×
        </button>
      </header>

      {tab === "chat" ? <ChatTab /> : <SettingsTab />}
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className={`chat-tab${active ? " chat-tab--active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}
