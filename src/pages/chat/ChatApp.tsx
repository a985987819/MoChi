import { useCallback, useState } from "react";
import { ChatTab } from "./ChatTab";
import { TodosTab } from "./TodosTab";
import { SettingsTab } from "./SettingsTab";
import { sendUIEvent, UI_EVENTS } from "@/shared/events";
import { MochiPlaceholder } from "@/shared/components/MochiPlaceholder";
import "./chat.css";

/**
 * 聊天窗（chat）—— v0.4.0：Tabs（聊天/待办/设置）。
 * 后续预留：番茄钟 Tab（v0.7.0）。
 */
type TabId = "chat" | "todos" | "settings";

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
          Mochi
        </span>
        <nav className="chat-tabs" onClick={e => e.stopPropagation()}>
          <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
            聊天
          </TabButton>
          <TabButton active={tab === "todos"} onClick={() => setTab("todos")}>
            待办
          </TabButton>
          <TabButton active={tab === "settings"} onClick={() => setTab("settings")}>
            设置
          </TabButton>
        </nav>
        <button className="chat-titlebar__close" onClick={handleClose} aria-label="关闭窗口">
          ×
        </button>
      </header>

      {tab === "chat" && <ChatTab />}
      {tab === "todos" && <TodosTab />}
      {tab === "settings" && <SettingsTab />}
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
