import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { listen } from "@tauri-apps/api/event";
import { agentFacade } from "@/agent/facade";
import { historyStore } from "@/agent/memory/history-store";
import { sendUIEvent, STATE_EVENTS, UI_EVENTS } from "@/shared/events";
import { truncateForBubble } from "@/shared/bubble-text";
import type { ProviderError } from "@/agent/providers";
import { isProviderReady, loadSettings, type AppSettings } from "@/services/settings";

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
}

let nextId = 1;

/** SQLite 协议消息 → UI 条目（tool 明细并入 assistant 的 note，不单气泡展示） */
async function loadEntries(): Promise<ChatEntry[]> {
  const msgs = await historyStore.loadRecent(24);
  const out: ChatEntry[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({ id: nextId++, role: "user", content: m.content ?? "" });
    } else if (m.role === "assistant") {
      if (m.toolCalls?.length) {
        out.push({ id: nextId++, role: "note", content: `🔧 调用了 ${m.toolCalls.map(c => c.name).join(" · ")}` });
      }
      if (m.content) out.push({ id: nextId++, role: "assistant", content: m.content });
    }
    // role==="tool"：结果已随其 assistant 的 note 呈现，跳过
  }
  return out;
}

export function ChatTab() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProviderError | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !settings) return;
    const ready = isProviderReady(settings);
    if (!ready.ok) {
      setError({ kind: "bad-request", message: ready.reason ?? "提供商未就绪" });
      return;
    }

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

    try {
      // 历史与持久化都在 Facade 内部闭环（v0.5.0 起 runTurn 不再接收 history）
      let finalText = "";
      for await (const ev of agentFacade.runTurn({ userInput: text, signal: controller.signal })) {
        if (ev.type === "text-delta") {
          finalText += ev.text;
          setEntries(prev => prev.map(e => (e.id === assistantEntry.id ? { ...e, content: e.content + ev.text } : e)));
        } else if (ev.type === "step-end") {
          const trace = ev.toolSummaries.map(s => `${s.name} ${s.ok ? "✓" : "✗"}`).join(" · ");
          setEntries(prev => [...prev, { id: nextId++, role: "note", content: `🔧 ${trace}` }]);
        } else if (ev.type === "done") {
          // done.text 恒为终答全文（含 hitMaxSteps 的兜底文案），覆盖增量拼接更可靠
          finalText = ev.text;
          if (ev.hitMaxSteps) patchAssistant({ content: ev.text });
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
    } finally {
      patchAssistant({ streaming: false });
      setBusy(false);
      abortRef.current = null;
    }
  }, [input, busy, settings, entries]);

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
            <p>
              跟麻薯说句话吧～
              <br />
              试试：<strong>帮我加个待办：明天九点开周会</strong>，或夸夸它。
            </p>
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
                {e.role === "assistant" && !e.streaming ? (
                  <MarkdownView text={e.content} />
                ) : (
                  <span className="chat-msg__plain">
                    {e.content}
                    {e.streaming && <span className="chat-cursor" aria-hidden />}
                  </span>
                )}
              </div>
            </div>
          ),
        )}
      </div>

      {error && (
        <div className="chat-error">
          <span>
            [{error.kind}] {error.message}
          </span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div className="chat-composer">
        <textarea
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

function MarkdownView({ text }: { text: string }) {
  if (!text.trim()) return <span className="chat-msg__plain">（空回复）</span>;
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

