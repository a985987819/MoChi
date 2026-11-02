import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { agentFacade } from "@/agent/facade";
import type { ChatMessage } from "@/agent/providers/types";
import type { ProviderError } from "@/agent/providers";
import { isProviderReady, loadSettings, type AppSettings } from "@/services/settings";

/**
 * 聊天 Tab —— v0.4.0：接入 AgentFacade（工具循环）。
 *
 * 与 v0.3.0 的差异：
 * - 发送走 agentFacade.runTurn（Agent 循环），不再直连 provider；
 * - 新增 `note` 条目：工具调用轨迹（🔧 add_todo ✓）——给用户可感知的工具反馈，
 *   但**不进协议历史**（协议只含 user/assistant/tool，note 是纯 UI 层）；
 * - 宠物情绪联动在 Facade 内部完成（thinking/talking），本组件无感知。
 */

interface ChatEntry {
  id: number;
  role: "user" | "assistant" | "note";
  content: string;
  streaming?: boolean;
}

let nextId = 1;

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

    // 协议历史：只取 user/assistant 文本轮次（note 是 UI 轨迹，不进协议；
    // v0.5.0 起换 SQLite 全协议历史——见 Facade 注释）
    const history: ChatMessage[] = entries
      .filter(e => e.role !== "note")
      .map(e => ({ role: e.role as "user" | "assistant", content: e.content }));

    const userEntry: ChatEntry = { id: nextId++, role: "user", content: text };
    const assistantEntry: ChatEntry = { id: nextId++, role: "assistant", content: "", streaming: true };
    setEntries(prev => [...prev, userEntry, assistantEntry]);

    const controller = new AbortController();
    abortRef.current = controller;

    const patchAssistant = (patch: Partial<ChatEntry>) =>
      setEntries(prev => prev.map(e => (e.id === assistantEntry.id ? { ...e, ...patch } : e)));

    try {
      for await (const ev of agentFacade.runTurn({ history, userInput: text, signal: controller.signal })) {
        if (ev.type === "text-delta") {
          setEntries(prev => prev.map(e => (e.id === assistantEntry.id ? { ...e, content: e.content + ev.text } : e)));
        } else if (ev.type === "step-end") {
          const trace = ev.toolSummaries.map(s => `${s.name} ${s.ok ? "✓" : "✗"}`).join(" · ");
          setEntries(prev => [...prev, { id: nextId++, role: "note", content: `🔧 ${trace}` }]);
        } else if (ev.type === "done") {
          // hitMaxSteps 时 runAgent 给的是兜底文案（没有对应 delta），补进气泡
          if (ev.hitMaxSteps) patchAssistant({ content: ev.text });
        }
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
