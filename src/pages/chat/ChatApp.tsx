import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChatTab } from "./ChatTab";
import { TodosTab } from "./TodosTab";
import { PomodoroTab } from "./PomodoroTab";
import { SettingsTab } from "./SettingsTab";
import { WelcomeGuide } from "./WelcomeGuide";
import { sendUIEvent, BRIDGE_EVENTS, STATE_EVENTS, UI_EVENTS } from "@/shared/events";
import { loadSettings, saveSettings } from "@/services/settings";
import { MochiPlaceholder } from "@/shared/components/MochiPlaceholder";
import "./chat.css";

/**
 * 聊天窗（chat）—— v0.7.0：Tabs（聊天/待办/番茄钟/设置）。
 *
 * v0.9.0 增加首次启动引导：`onboardingDone === false` 时用 WelcomeGuide 覆盖内容区，
 * 此时隐藏 Tab 栏（避免"引导在上、Tab 在下"两套导航抢注意力），关闭按钮保留。
 * 触发来源有两处——首次启动（pet 窗自动打开聊天窗）与设置页的「重新显示」事件。
 */
type TabId = "chat" | "todos" | "pomodoro" | "settings";

/** open-chat 载荷的 tab 字段收窄（非法值回落 chat——收方校验，协议文档见 events.ts） */
function asTabId(v: unknown): TabId {
  return v === "todos" || v === "pomodoro" || v === "settings" || v === "chat" ? v : "chat";
}

export function ChatApp() {
  const [tab, setTab] = useState<TabId>("chat");
  const [welcome, setWelcome] = useState(false);

  // ① 首装/升级用户：读设置判断是否要展示引导
  useEffect(() => {
    void loadSettings().then(s => {
      if (!s.onboardingDone) setWelcome(true);
    });
  }, []);

  // ② 设置页「重新显示新手引导」：同一个覆盖层被事件叫出来
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen(STATE_EVENTS.onboardingRequested, () => {
      setTab("chat");
      setWelcome(true);
    }).then(unlisten => {
      off = unlisten;
    });
    return () => off?.();
  }, []);

  // ③ 右键菜单/托盘「设置…」等直达入口（P1-02）：Rust 转发 open-chat 的 {tab} 载荷
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen<{ tab?: unknown }>(BRIDGE_EVENTS.chatOpen, e => {
      setTab(asTabId(e.payload?.tab));
    }).then(unlisten => {
      off = unlisten;
    });
    return () => off?.();
  }, []);

  /**
   * 结束引导：先切到目标 Tab 再落盘。
   * 落盘失败（极少见：磁盘只读）不影响本次体验——下次启动会再看到一次，
   * 这是可接受的降级方向（宁可多讲一次，也不要让用户错过）。
   */
  const finishWelcome = useCallback(async (destination: "chat" | "settings") => {
    setWelcome(false);
    setTab(destination);
    const settings = await loadSettings();
    if (!settings.onboardingDone) await saveSettings({ ...settings, onboardingDone: true }, ["onboardingDone"]);
  }, []);

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
        {!welcome && (
          <nav className="chat-tabs" onClick={e => e.stopPropagation()}>
            <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
              聊天
            </TabButton>
            <TabButton active={tab === "todos"} onClick={() => setTab("todos")}>
              待办
            </TabButton>
            <TabButton active={tab === "pomodoro"} onClick={() => setTab("pomodoro")}>
              番茄钟
            </TabButton>
            <TabButton active={tab === "settings"} onClick={() => setTab("settings")}>
              设置
            </TabButton>
          </nav>
        )}
        <button className="chat-titlebar__close" onClick={handleClose} aria-label="关闭窗口">
          ×
        </button>
      </header>

      {welcome ? (
        <WelcomeGuide onFinish={finishWelcome} />
      ) : (
        <>
          {tab === "chat" && <ChatTab />}
          {tab === "todos" && <TodosTab />}
          {tab === "pomodoro" && <PomodoroTab />}
          {tab === "settings" && <SettingsTab />}
        </>
      )}
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
