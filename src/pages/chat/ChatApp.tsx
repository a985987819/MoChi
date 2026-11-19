import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChatTab } from "./ChatTab";
import { TodosTab } from "./TodosTab";
import { PomodoroTab } from "./PomodoroTab";
import { RemindersTab } from "./RemindersTab";
import { AssetsTab } from "./AssetsTab";
import { SettingsTab } from "./SettingsTab";
import { WelcomeGuide } from "./WelcomeGuide";
import { sendUIEvent, BRIDGE_EVENTS, STATE_EVENTS, UI_EVENTS } from "@/shared/events";
import { playShowTransition, onWindowShown } from "@/shared/show-transition";
import { loadSettings, saveSettings } from "@/services/settings";
import { reminderStore } from "@/services/reminders";
import { stopSpeaking } from "@/services/tts";
import { dragWindow } from "@/shared/window-drag";
import { useT } from "@/shared/i18n/react";
import { MochiPlaceholder } from "@/shared/components/MochiPlaceholder";
import "./chat.css";

/**
 * 聊天窗（chat）—— v0.7.0：Tabs（聊天/待办/番茄钟/设置）。
 *
 * v0.9.2 增加「素材」Tab：双语图片导入页（讲清每个状态代表什么、导入时自动改成英文名）。
 *
 * v0.14.0 增加「提醒」Tab（提醒中心，P1-02）：进行中 + 历史 + 未确认角标，
 * 从番茄钟页拆出——提醒有了历史之后是独立的心智单元。
 *
 * v0.9.0 增加首次启动引导：`onboardingDone === false` 时用 WelcomeGuide 覆盖内容区，
 * 此时隐藏 Tab 栏（避免"引导在上、Tab 在下"两套导航抢注意力），关闭按钮保留。
 * 触发来源有两处——首次启动（pet 窗自动打开聊天窗）与设置页的「重新显示」事件。
 */
type TabId = "chat" | "todos" | "reminders" | "pomodoro" | "assets" | "settings";

/** open-chat 载荷的 tab 字段收窄（非法值回落 chat——收方校验，协议文档见 events.ts） */
function asTabId(v: unknown): TabId {
  return v === "todos" || v === "reminders" || v === "pomodoro" || v === "assets" || v === "settings" || v === "chat"
    ? v
    : "chat";
}

export function ChatApp() {
  const { t } = useT();
  const [tab, setTab] = useState<TabId>("chat");
  const [welcome, setWelcome] = useState(false);
  const shellRef = useRef<HTMLElement>(null);
  /** 未确认提醒数（P1-02）：提醒 Tab 上的角标，>0 才渲染 */
  const [unacked, setUnacked] = useState(0);

  // 窗口唤回（托盘/快捷键打开已隐藏的聊天窗）时的轻过渡：淡入+上浮 160ms。
  // show() 本身是硬切，闪现显得像卡顿；WAAPI 合成器动画零布局成本。
  useEffect(() => onWindowShown(() => playShowTransition(shellRef.current)), []);

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

  // ④ 未确认提醒角标（P1-02 / v0.14.0）：数据源是 reminders 表（SQLite 单一事实源），
  //    变化节奏由 remindersChanged 广播对齐——创建/触发/确认落库时调度器与 Store 都会广播。
  //    查询失败静默为 0：角标是提示，不该在聊天窗标题栏报错。
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    const refresh = () => {
      void reminderStore
        .unacknowledgedCount()
        .then(n => {
          if (!disposed) setUnacked(n);
        })
        .catch(() => undefined);
    };
    refresh();
    void listen(STATE_EVENTS.remindersChanged, refresh).then(unlisten => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
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
    if (!settings.onboardingDone) await saveSettings({ ...settings, onboardingDone: true });
  }, []);

  /** 「以后不再自动显示」（P1-09）：不切 Tab，只落盘退出引导 */
  const dismissForever = useCallback(async () => {
    setWelcome(false);
    const settings = await loadSettings();
    if (!settings.onboardingDone) await saveSettings({ ...settings, onboardingDone: true });
  }, []);

  const handleClose = useCallback(() => {
    stopSpeaking(); // 关窗 = 用户离开对话（P1-03）：不留半句悬着的朗读
    void sendUIEvent(UI_EVENTS.hideChat);
  }, []);

  return (
    <>
    <main ref={shellRef} className="chat-shell">
      {/* 自绘标题栏（v0.23.1）：**整行可抓**拖动——手动 mousedown + startDragging
          （排除 Tab/关闭钮等交互控件），替代 data-tauri-drag-region 的"仅元素本身
          生效"限制。Tab 之间的空隙、标题两侧都能抓，拖拽方便很多。 */}
      <header className="chat-titlebar" onMouseDown={dragWindow}>
        <span className="chat-titlebar__title">
          <MochiPlaceholder size={18} />
          Mochi
        </span>
        {!welcome && (
          <nav className="chat-tabs" onClick={e => e.stopPropagation()}>
            <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
              {t("tab.chat")}
            </TabButton>
            <TabButton active={tab === "todos"} onClick={() => setTab("todos")}>
              {t("tab.todos")}
            </TabButton>
            <TabButton active={tab === "reminders"} onClick={() => setTab("reminders")} badge={unacked}>
              {t("tab.reminders")}
            </TabButton>
            <TabButton active={tab === "pomodoro"} onClick={() => setTab("pomodoro")}>
              {t("tab.pomodoro")}
            </TabButton>
            <TabButton active={tab === "assets"} onClick={() => setTab("assets")}>
              {t("tab.assets")}
            </TabButton>
            <TabButton active={tab === "settings"} onClick={() => setTab("settings")}>
              {t("tab.settings")}
            </TabButton>
          </nav>
        )}
        <button className="chat-titlebar__close" onClick={handleClose} aria-label={t("tab.closeWindow")}>
          ×
        </button>
      </header>

      {welcome ? (
        <WelcomeGuide onFinish={finishWelcome} onDismissForever={() => void dismissForever()} />
      ) : (
        <>
          {/* keep-alive：六个 Tab 常驻不卸载，切换只切 visible——旧条件渲染会在
              每次切换时重挂组件（聊天历史重查 SQLite、设置重读 store、监听反复
              装卸），既闪又费。CSS 入场动画在 display:none→显示时自动重播，
              切换的"进入感"零 JS 成本。 */}
          <div className="chat-tab-page" hidden={tab !== "chat"}>
            <ChatTab onOpenSettings={() => setTab("settings")} />
          </div>
          <div className="chat-tab-page" hidden={tab !== "todos"}>
            <TodosTab />
          </div>
          <div className="chat-tab-page" hidden={tab !== "reminders"}>
            <RemindersTab />
          </div>
          <div className="chat-tab-page" hidden={tab !== "pomodoro"}>
            <PomodoroTab />
          </div>
          <div className="chat-tab-page" hidden={tab !== "assets"}>
            <AssetsTab />
          </div>
          <div className="chat-tab-page" hidden={tab !== "settings"}>
            <SettingsTab />
          </div>
        </>
      )}
    </main>
    {/* 缩放热区放在 shell 外：避免被圆角 + overflow:hidden 裁掉 */}
    {!welcome && <ResizeHandles />}
    </>
  );
}

/**
 * 无边框窗口的八向缩放热区（v0.29.1）。
 *
 * 聊天窗是 `decorations: false` 自绘窗口，没有系统边框；WebView 里在四边/四角铺
 * 4~10px 的透明热区，按下即把缩放交给系统（`startResizeDragging`）——手感与原生
 * 窗口一致；该命令不在 core:window:default 里，capability 已显式授权
 * `core:window:allow-start-resize-dragging`。热区固定定位、z-index 高于内容，
 * 但不拦截标题栏拖动（它们不在 header 内）。
 */
/** @tauri-apps/api 没把 ResizeDirection 作为命名类型导出，这里按 API 文档字面量对齐 */
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const RESIZE_HANDLES: ReadonlyArray<{ direction: ResizeDirection; edge: string }> = [
  { direction: "North", edge: "n" },
  { direction: "South", edge: "s" },
  { direction: "East", edge: "e" },
  { direction: "West", edge: "w" },
  { direction: "NorthEast", edge: "ne" },
  { direction: "NorthWest", edge: "nw" },
  { direction: "SouthEast", edge: "se" },
  { direction: "SouthWest", edge: "sw" },
];

function ResizeHandles() {
  return (
    <>
      {RESIZE_HANDLES.map(({ direction, edge }) => (
        <div
          key={direction}
          id={`chat-resize-${edge}`}
          className={`chat-resize chat-resize--${edge}`}
          data-no-drag
          onMouseDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            void getCurrentWindow().startResizeDragging(direction).catch(() => undefined);
          }}
        />
      ))}
    </>
  );
}

function TabButton({
  active,
  onClick,
  badge,
  children,
}: {
  active: boolean;
  onClick: () => void;
  /** 未确认提醒数（v0.14.0）：>0 才渲染角标；9 以上显示 9+（挤不下的诚实显示法） */
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <button className={`chat-tab${active ? " chat-tab--active" : ""}`} onClick={onClick}>
      {children}
      {badge != null && badge > 0 && <span className="chat-tab__badge">{badge > 9 ? "9+" : badge}</span>}
    </button>
  );
}
