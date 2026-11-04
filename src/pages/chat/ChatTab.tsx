import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { listen } from "@tauri-apps/api/event";
import { agentFacade } from "@/agent/facade";
import { historyStore } from "@/agent/memory/history-store";
import { sendUIEvent, STATE_EVENTS, UI_EVENTS } from "@/shared/events";
import { truncateForBubble } from "@/shared/bubble-text";
import type { ProviderError } from "@/agent/providers";
import { isProviderReady, loadSettings, type AppSettings } from "@/services/settings";
import { toFriendlyError } from "@/agent/error-text";
import { formatToolTrace } from "./tool-labels";

/**
 * 聊天 Tab —— v0.5.0：历史从 SQLite 恢复（情景记忆），发送走 Facade（内部闭环
 * 记忆检索/窗口裁剪/协议持久化），本组件只管渲染与输入。
 * note 条目：工具轨迹（实时来自 step-end；历史恢复时来自 assistant.toolCalls）。
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

/**
 * 空态指令 chips（P1-12）：点一下填入输入框（**不自动发送**——自动发送会让
 * 用户觉得失去控制权，施工单附录 B 交互约定），聚焦输入框等用户改改再发。
 */
const EMPTY_CHIPS = [
  "帮我加个待办：明天九点开周会",
  "来个番茄钟",
  "巨无霸多少热量",
  "记住我晚上不喝咖啡",
] as const;

/** SQLite 协议消息 → UI 条目（tool 明细并入 assistant 的 note，不单气泡展示） */
async function loadEntries(): Promise<ChatEntry[]> {
  const msgs = await historyStore.loadRecent(24);
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
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProviderError | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastInputRef = useRef("");

  useEffect(() => {
    void loadSettings().then(setSettings);
    void loadEntries().then(setEntries);
    // 设置页清空历史 → 本窗重载（空）
    const unlisten = listen(STATE_EVENTS.historyCleared, () => {
      void loadEntries().then(setEntries);
    });
    return () => {
      void unlisten.then(off => off());
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
        setError({ kind: "bad-request", message: ready.reason ?? "提供商未就绪" });
        return;
      }
      lastInputRef.current = text; // 失败重试（P1-07/08）重发最近一次输入

      setError(null);
      setInput("");
    setBusy(true);

    const userEntry: ChatEntry = { id: nextId++, role: "user", content: text };
    const assistantEntry: ChatEntry = { id: nextId++, role: "assistant", content: "", streaming: true };
    setEntries(prev => [...prev, userEntry, assistantEntry]);

    const controller = new AbortController();
    abortRef.current = controller;

    const patchAssistant = (patch: Partial<ChatEntry>) =>
      setEntries(prev => prev.map(e => (e.id === assistantEntry.id ? { ...e, ...patch } : e)));

    // 流式节流（P1-05）：delta 高频到达，直接 setState 会让 MarkdownView 每秒
    // 重解析几十次——攒进缓冲，80ms 冲刷一次（~12fps，肉眼即"逐字"）
    let streamBuffer = "";
    let lastFlush = 0;
    const flushStream = (force = false) => {
      const now = performance.now();
      if (!force && now - lastFlush < STREAM_THROTTLE_MS) return;
      if (!streamBuffer) return;
      const chunk = streamBuffer;
      streamBuffer = "";
      lastFlush = now;
      setEntries(prev => prev.map(e => (e.id === assistantEntry.id ? { ...e, content: e.content + chunk } : e)));
    };

    try {
      // 历史与持久化都在 Facade 内部闭环（v0.5.0 起 runTurn 不再接收 history）
      let finalText = "";
      for await (const ev of agentFacade.runTurn({ userInput: text, signal: controller.signal })) {
        if (ev.type === "text-delta") {
          finalText += ev.text;
          streamBuffer += ev.text;
          flushStream();
        } else if (ev.type === "step-end") {
          // 工具轨迹人话化（P1-06）：内部动作（set_pet_state）不产生 note
          const trace = formatToolTrace(ev.toolSummaries);
          if (trace) setEntries(prev => [...prev, { id: nextId++, role: "note", content: `🔧 ${trace}` }]);
        } else if (ev.type === "done") {
          // done.text 恒为终答全文（含 hitMaxSteps 兜底），权威覆盖，清掉缓冲
          finalText = ev.text;
          streamBuffer = "";
          patchAssistant({ content: ev.text });
        }
      }
      // 气泡（P1-01）：回复完成但用户没看着聊天窗（关窗=隐藏，进程常驻），
      // 把终答摘要浮到宠物头顶。看着的时候不发——用户正在聊天窗里，气泡是打扰。
      // 直接查本窗 document.visibilityState：WebView 隐藏窗口会触发 visibility
      // 变化，无需跨窗口维护 chatVisible 状态（比施工单建议的方案少一条事件）
      if (document.visibilityState === "hidden") {
        const summary = truncateForBubble(finalText);
        if (summary) void sendUIEvent(UI_EVENTS.showBubble, summary);
      }
    } catch (e) {
      setError({ kind: "network", message: String(e) });
      patchAssistant({ failed: true, retryText: text }); // 失败气泡出「重试」（P1-08）
    } finally {
      flushStream(true); // 中断/出错时冲刷缓冲：已生成的部分文本保留在界面上
      patchAssistant({ streaming: false });
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, settings]); // entries 不进依赖：全程用函数式更新（P2-16 顺带修复闭包重建）

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
        {entries.length === 0 && (
          <div className="chat-empty">
            <p>跟麻薯说句话吧～</p>
            <div className="chat-empty__chips">
              {EMPTY_CHIPS.map(text => (
                <button
                  key={text}
                  className="chat-chip"
                  onClick={() => {
                    setInput(text);
                    textareaRef.current?.focus();
                  }}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        )}
        {entries.map(e =>
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
                    {copiedId === e.id ? "已复制" : "复制"}
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
                  重试
                </button>
              )}
            </div>
          ),
        )}
      </div>

      {error &&
        (() => {
          // 人话错误条（P1-07）：一句话主文案 + 下一步动作按钮；原始报错收进折叠详情
          const friendly = toFriendlyError(error);
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
                <summary>详情</summary>
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
          placeholder="说点什么…（Enter 发送 / Shift+Enter 换行）"
          rows={2}
        />
        {busy ? (
          <button className="chat-send chat-send--stop" onClick={stop}>
            停止
          </button>
        ) : (
          <button className="chat-send" onClick={() => void send()} disabled={!input.trim()}>
            发送
          </button>
        )}
      </div>
    </section>
  );
}

/** Markdown 渲染（memo 化，P1-05）：非流式消息在流式重渲染中零开销——
 *  entry 对象引用不变，memo 直接跳过重解析 */
const MarkdownView = memo(function MarkdownView({ text, streaming }: { text: string; streaming?: boolean }) {
  if (!text.trim() && !streaming) return <span className="chat-msg__plain">（空回复）</span>;
  return (
    <div className={`chat-md${streaming ? " chat-md--streaming" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

