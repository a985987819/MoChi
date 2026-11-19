import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { listen } from "@tauri-apps/api/event";
import { agentFacade } from "@/agent/facade";
import { historyStore } from "@/agent/memory/history-store";
import { sendUIEvent, STATE_EVENTS, UI_EVENTS } from "@/shared/events";
import { tailForBubble, truncateForBubble } from "@/shared/bubble-text";
import { SkeletonLines } from "@/shared/components/Loading";
import { answerLocally, isLocalAnswer, localKnowledgeSize } from "@/rag/local-qa";
import { useT } from "@/shared/i18n/react";
import { t } from "@/shared/i18n/core";
import { dragWindow } from "@/shared/window-drag";
import type { MessageKey } from "@/shared/i18n/zh-CN";
import type { ProviderError } from "@/agent/providers";
import { isProviderReady, loadSettings, type AppSettings } from "@/services/settings";
import { applyTtsFromSettings, speak, stopSpeaking } from "@/services/tts";
import { toFriendlyError } from "@/agent/error-text";
import { getPetSelfName } from "@/shared/i18n/core";
import { formatToolTrace } from "./tool-labels";

/**
 * 聊天 Tab —— v0.5.0：历史从 SQLite 恢复（情景记忆），发送走 Facade（内部闭环
 * 记忆检索/窗口裁剪/协议持久化），本组件只管渲染与输入。
 * note 条目：工具轨迹（实时来自 step-end；历史恢复时来自 assistant.toolCalls）。
 * v0.21.0：文案迁入 i18n（OFFLINE_GUIDANCE → chat.offlineGuidance，插值知识库规模）。
 */

interface ChatEntry {
  id: number;
  role: "user" | "assistant" | "note";
  content: string;
  streaming?: boolean;
  /** 本轮失败（流中断/异常）——气泡下出「重试」按钮，记着当时的用户输入（P1-08） */
  failed?: boolean;
  retryText?: string;
}

let nextId = 1;

/** 流式增量冲刷间隔（ms）：~12fps 的重解析频率，肉眼仍是"逐字"（P1-05） */
const STREAM_THROTTLE_MS = 80;

/** 流式气泡广播节流（v0.27.0）：80ms 冲刷比气泡更新需要的频率高，300ms 一拍足够顺滑 */
const BUBBLE_STREAM_THROTTLE_MS = 300;

/**
 * 空态指令 chips（P1-12）：点一下填入输入框（**不自动发送**——自动发送会让
 * 用户觉得失去控制权，施工单附录 B 交互约定），聚焦输入框等用户改改再发。
 * v0.21.0：值改为 i18n key，填输入框时经 t() 翻译成当前语言。
 */
const EMPTY_CHIPS: MessageKey[] = [
  "chat.chip1",
  "chat.chip2",
  "chat.chip3",
  "chat.chip4",
];

/** SQLite 协议消息 → UI 条目（tool 明细并入 assistant 的 note，不单气泡展示） */
async function loadEntries(): Promise<ChatEntry[]> {
  // 展示窗口（v0.27.0）：24 → 50 块——「保留历史会话」的 UI 侧；发给模型的上下文
  // 仍由 trimWindow 预算裁剪（展示与上下文控制解耦，用户要求历史不丢）
  const msgs = await historyStore.loadRecent(50);
  const out: ChatEntry[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({ id: nextId++, role: "user", content: m.content ?? "" });
    } else if (m.role === "assistant") {
      // 历史轨迹同样走人话文案（P1-06）；历史里没有 ok 记录（都执行过），按成功渲染
      const trace = formatToolTrace(m.toolCalls?.map(c => ({ name: c.name, ok: true })) ?? []);
      if (trace) {
        out.push({ id: nextId++, role: "note", content: `🔧 ${trace}` });
      }
      if (m.content) out.push({ id: nextId++, role: "assistant", content: m.content });
    }
    // role==="tool"：结果已随其 assistant 的 note 呈现，跳过
  }
  return out;
}

export function ChatTab({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useT();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [entries, setEntries] = useState<ChatEntry[] | null>(null); // null=历史加载中
  const [historyError, setHistoryError] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProviderError | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastInputRef = useRef("");

  // 历史读取失败给可见的重试入口（SQLite 被锁/磁盘抖动不该变成"永远空历史"）。
  const reloadHistory = useCallback(() => {
    setHistoryError(false);
    void loadEntries().then(setEntries).catch(() => setHistoryError(true));
  }, []);

  useEffect(() => {
    void loadSettings().then(setSettings);
    reloadHistory();
    // 设置页清空历史 → 本窗重载（空）
    const unlisten = listen(STATE_EVENTS.historyCleared, () => {
      reloadHistory();
    });
    return () => {
      void unlisten.then(off => off());
    };
  }, [reloadHistory]);

  // TTS（v0.15.0）：配置跟随设置（启动读一次 + settingsChanged 跟随）；
  // 「打断」的第二条通道——单击宠物（petClicked 全窗广播）也停读。
  // v0.29.2：单击不再重置站立，专用事件名与计时语义解耦。
  // 朗读只在聊天窗发生（回复在这里结束），配置在这里应用就够了。
  useEffect(() => {
    void loadSettings().then(applyTtsFromSettings).catch(() => undefined);
    let disposed = false;
    const offs: Array<() => void> = [];
    void listen(STATE_EVENTS.settingsChanged, () => {
      void loadSettings()
        .then(applyTtsFromSettings)
        .catch(() => undefined);
    }).then(off => {
      if (disposed) off();
      else offs.push(off);
    });
    void listen(UI_EVENTS.petClicked, () => stopSpeaking()).then(off => {
      if (disposed) off();
      else offs.push(off);
    });
    return () => {
      disposed = true;
      for (const off of offs) off();
      stopSpeaking(); // 组件卸载（关窗/切引导）不留半句悬着的朗读
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries]);

  const doSend = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || busy || !settings) return;
      const ready = isProviderReady(settings);
      if (!ready.ok) {
        // 未连接大模型：健康/康复/营养/热量域的问题走**本地知识库**直接回答
        // （离线、零成本、毫秒级）；范围之外如实告知需要连接大模型并给出路径，
        // 不再是冷冰冰的红色报错——这是能力边界教育，不是故障。
        const local = answerLocally(text);
        setInput("");
        if (isLocalAnswer(local)) {
          // 离线路径同样落库（v0.27.0 会话丢失修复）：原来的"当场可查"设计让重启后
          // 这些对话凭空消失，正是「会话丢失」观感的来源之一。用户诉求历史保留。
          setEntries(prev => [
            ...(prev ?? []),
            { id: nextId++, role: "user", content: text },
            { id: nextId++, role: "note", content: t("chat.localNote", { count: local.count }) },
            { id: nextId++, role: "assistant", content: local.text },
          ]);
          void historyStore.appendUserDeduped(text);
          void historyStore.append([{ role: "assistant", content: local.text }]);
          speak(local.text); // 本地回答也是"麻薯说的话"（v0.15.0 TTS；开关/免打扰内部判断）
          return;
        }
        // 未连接大模型的引导话术不落库（静态模板，落库只会污染上下文）；
        // 用户消息本身由下方在线路径的语义覆盖——这里只做 UI 提示。
        setEntries(prev => [
          ...(prev ?? []),
          { id: nextId++, role: "user", content: text },
          { id: nextId++, role: "assistant", content: t("chat.offlineGuidance", { knowledge: localKnowledgeSize() }) },
        ]);
        return;
      }
      lastInputRef.current = text; // 失败重试（P1-07/08）重发最近一次输入

      stopSpeaking(); // 新消息打断正在进行的朗读（P1-03：随时可打断）
      setError(null);
      setInput("");
    setBusy(true);

    const userEntry: ChatEntry = { id: nextId++, role: "user", content: text };
    const assistantEntry: ChatEntry = { id: nextId++, role: "assistant", content: "", streaming: true };
    setEntries(prev => [...(prev ?? []), userEntry, assistantEntry]);

    const controller = new AbortController();
    abortRef.current = controller;

    const patchAssistant = (patch: Partial<ChatEntry>) =>
      setEntries(prev => (prev ?? []).map(e => (e.id === assistantEntry.id ? { ...e, ...patch } : e)));

    // 流式节流（P1-05）：delta 高频到达，直接 setState 会让 MarkdownView 每秒
    // 重解析几十次——攒进缓冲，80ms 冲刷一次（~12fps，肉眼即"逐字"）
    let streamBuffer = "";
    let lastFlush = 0;
    let lastBubbleFlush = 0;
    // 已生成的全文（流式气泡尾部截取用）：声明在 flushStream 之前——闭包引用它
    let finalText = "";
    const flushStream = (force = false) => {
      const now = performance.now();
      if (!force && now - lastFlush < STREAM_THROTTLE_MS) return;
      if (!streamBuffer) return;
      const chunk = streamBuffer;
      streamBuffer = "";
      lastFlush = now;
      setEntries(prev => (prev ?? []).map(e => (e.id === assistantEntry.id ? { ...e, content: e.content + chunk } : e)));
      // 流式气泡（v0.27.0）：300ms 节流推送尾部——宠物头顶随回复增长逐字展示
      if (now - lastBubbleFlush >= BUBBLE_STREAM_THROTTLE_MS) {
        lastBubbleFlush = now;
        void sendUIEvent(UI_EVENTS.bubbleStream, { text: tailForBubble(finalText), done: false }).catch(() => undefined);
      }
    };

    try {
      // 历史与持久化都在 Facade 内部闭环（v0.5.0 起 runTurn 不再接收 history）
      for await (const ev of agentFacade.runTurn({ userInput: text, signal: controller.signal })) {
        if (ev.type === "text-delta") {
          finalText += ev.text;
          streamBuffer += ev.text;
          flushStream();
        } else if (ev.type === "step-end") {
          // 工具轨迹人话化（P1-06）：内部动作（set_pet_state）不产生 note
          const trace = formatToolTrace(ev.toolSummaries);
          if (trace) setEntries(prev => [...(prev ?? []), { id: nextId++, role: "note", content: `🔧 ${trace}` }]);
        } else if (ev.type === "done") {
          // done.text 恒为终答全文（含 hitMaxSteps 兜底），权威覆盖，清掉缓冲
          finalText = ev.text;
          streamBuffer = "";
          patchAssistant({ content: ev.text });
        }
      }
      // 流式气泡收尾（v0.27.0）：推最终摘要 + done=true——宠物气泡进入收尾淡出。
      // 替代 P1-01 的「仅隐藏窗口时发摘要」：流式期间气泡已全程展示，完成后统一
      // 收尾（聊天窗可见与否不再影响宠物的表现——用户要求宠物流式展示回复）。
      void sendUIEvent(UI_EVENTS.bubbleStream, { text: truncateForBubble(finalText), done: true }).catch(() => undefined);
      // 朗读（v0.15.0 P1-03）：回复**完整结束后**才读（流式中读会结巴）。
      // 开关关闭/免打扰/纯代码块都在 speak 内部静默处理；出错路径不读（catch）。
      speak(finalText);
    } catch (e) {
      setError({ kind: "network", message: String(e) });
      patchAssistant({ failed: true, retryText: text }); // 失败气泡出「重试」（P1-08）
    } finally {
      flushStream(true); // 中断/出错时冲刷缓冲：已生成的部分文本保留在界面上
      patchAssistant({ streaming: false });
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, settings, t]); // entries 不进依赖：全程用函数式更新（P2-16 顺带修复闭包重建）

  const send = useCallback(() => void doSend(input), [doSend, input]);

  /** 重试最近一次输入（P1-07 错误条 / P1-08 失败气泡共用） */
  const retryLast = useCallback(() => void doSend(lastInputRef.current), [doSend]);

  // 复制（P1-08）：取气泡内 Markdown 渲染后的可见文本（innerText 保留换行），
  // 失败降级为复制源文本；「已复制」1.5s 后回落
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copyEntry = useCallback((entry: ChatEntry, bubble: HTMLElement | null) => {
    const rendered = bubble?.querySelector<HTMLElement>(".chat-md")?.innerText;
    const text = rendered?.trim() ? rendered : entry.content;
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopiedId(entry.id))
      .catch(() => setCopiedId(null));
  }, []);

  useEffect(() => {
    if (copiedId === null) return;
    const t = window.setTimeout(() => setCopiedId(null), 1500);
    return () => window.clearTimeout(t);
  }, [copiedId]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  return (
    <section className="chat-tab-panel">
      <div ref={listRef} className="chat-msg-list">
        {entries === null && !historyError && (
          // 历史加载中：两行骨架 + 输入区照常可用（读历史不阻塞发言）
          <div className="chat-history-loading">
            <SkeletonLines widths={[0.55, 0.75]} rows={2} />
          </div>
        )}
        {historyError && (
          <div className="chat-history-error" role="alert">
            <p>{t("chat.historyError")}</p>
            <button className="chat-chip" onClick={reloadHistory}>{t("chat.retry")}</button>
          </div>
        )}
        {entries !== null && entries.length === 0 && (
          <div className="chat-empty" onMouseDown={dragWindow}>
            <p>{t("chat.emptyHello")}</p>
            <div className="chat-empty__chips">
              {EMPTY_CHIPS.map(key => (
                <button
                  key={key}
                  className="chat-chip"
                  onClick={() => {
                    setInput(t(key));
                    textareaRef.current?.focus();
                  }}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        )}
        {entries?.map(e =>
          e.role === "note" ? (
            <div key={e.id} className="chat-note">
              {e.content}
            </div>
          ) : (
            <div key={e.id} className={`chat-msg chat-msg--${e.role}`}>
              <div className="chat-msg__bubble">
                {e.role === "assistant" && (
                  // 复制（P1-08）：hover 浮现。复制的是**渲染文本**
                  // （气泡 DOM 的 innerText，用户预期是"我刚看到的字"）
                  <button
                    className="chat-copy-btn"
                    onClick={ev => copyEntry(e, ev.currentTarget.closest(".chat-msg__bubble"))}
                  >
                    {copiedId === e.id ? t("chat.copied") : t("chat.copy")}
                  </button>
                )}
                {e.role === "assistant" ? (
                  // 流式也走 Markdown（P1-05）：结束才切换会导致排版跳变；
                  // 节流 + memo 把重解析控制在 ~12fps。光标用 CSS ::after
                  // 挂在最后一个元素上（.chat-md--streaming）
                  <MarkdownView text={e.content} streaming={e.streaming === true} />
                ) : (
                  <span className="chat-msg__plain">{e.content}</span>
                )}
              </div>
              {e.failed && (
                // 失败重试（P1-08）：重发**该轮**的用户输入（比"最后一条"更准——
                // 连续多轮失败时每条气泡知道自己的输入）
                <button className="chat-retry-btn" onClick={() => void doSend(e.retryText ?? "")}>
                  {t("chat.retry")}
                </button>
              )}
            </div>
          ),
        )}
      </div>

      {error &&
        (() => {
          // 人话错误条（P1-07）：一句话主文案 + 下一步动作按钮；原始报错收进折叠详情
          const friendly = toFriendlyError(error, getPetSelfName());
          return (
            <div className="chat-error">
              <div className="chat-error__row">
                <span className="chat-error__text">{friendly.headline}</span>
                {friendly.action === "settings" && (
                  <button className="chat-error__action" onClick={onOpenSettings}>
                    {friendly.actionLabel}
                  </button>
                )}
                {friendly.action === "retry" && (
                  <button className="chat-error__action" onClick={retryLast}>
                    {friendly.actionLabel}
                  </button>
                )}
                {friendly.action === "dismiss" && (
                  <button className="chat-error__action" onClick={() => setError(null)}>
                    {friendly.actionLabel}
                  </button>
                )}
              </div>
              <details className="chat-error__details">
                <summary>{t("chat.details")}</summary>
                <code>{error.message}</code>
              </details>
            </div>
          );
        })()}

      <div className="chat-composer">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("chat.placeholder")}
          rows={2}
        />
        {busy ? (
          <button className="chat-send chat-send--stop" onClick={stop}>
            {t("chat.stop")}
          </button>
        ) : (
          <button className="chat-send" onClick={() => void send()} disabled={!input.trim()}>
            {t("chat.send")}
          </button>
        )}
      </div>
    </section>
  );
}

/** Markdown 渲染（memo 化，P1-05）：非流式消息在流式重渲染中零开销——
 *  entry 对象引用不变，memo 直接跳过重解析 */
const MarkdownView = memo(function MarkdownView({ text, streaming }: { text: string; streaming?: boolean }) {
  // MarkdownView 是 memo 的非 hook 组件：t() 可直接调用（运行时读 locale，不依赖 hook）
  if (!text.trim() && !streaming) return <span className="chat-msg__plain">{t("chat.emptyReply")}</span>;
  return (
    <div className={`chat-md${streaming ? " chat-md--streaming" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

