import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createProvider, type ChatMessage, type ProviderError } from "@/agent/providers";
import { isProviderReady, loadSettings, type AppSettings } from "@/services/settings";

/**
 * 聊天 Tab —— v0.3.0：流式对话（无工具循环——那在 v0.4.0 的 AgentRunner）。
 *
 * 数据流：
 *   输入 → 组协议消息（历史全量重发，02 §2.1：模型无状态）→ chatStream
 *   → text-delta 增量拼到最后一条 assistant → finish 定格
 * 错误态：ProviderError 直接展示 kind+message（Key 不入日志/文案，02 §4.3）；
 * 停止：AbortController.abort() → 流短路 → 已生成文本保留。
 * 历史只在内存（v0.5.0 落 SQLite）；系统提示词 v0.4.0 由 context-builder 注入。
 */

interface ChatEntry {
  id: number;
  role: "user" | "assistant";
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

  // 自动滚底（v0.3 简化：始终滚底；"用户上翻则不扰"留 v0.4 打磨）
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

    // 协议消息 = 本窗历史全量（含刚push的两条；streaming 标志不进协议）
    const history: ChatMessage[] = [...entries, userEntry].map(e => ({ role: e.role, content: e.content }));
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const provider = createProvider(settings);
      for await (const ev of provider.chatStream({ messages: history }, controller.signal)) {
        if (ev.type === "text-delta") {
          setEntries(prev =>
            prev.map(e => (e.id === assistantEntry.id ? { ...e, content: e.content + ev.text } : e)),
          );
        } else if (ev.type === "error") {
          setError(ev.error);
          break;
        }
        // finish / tool-calls（v0.4.0 前不会出现）暂不处理
      }
    } catch (e) {
      setError({ kind: "network", message: String(e) });
    } finally {
      setEntries(prev => prev.map(e => (e.id === assistantEntry.id ? { ...e, streaming: false } : e)));
      setBusy(false);
      abortRef.current = null;
    }
  }, [input, busy, settings, entries]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault(); // Enter 发送、Shift+Enter 换行；isComposing 防中文输入法误发
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
              配置提供商后开始对话（<strong>设置</strong> Tab）。
              <br />
              没有 Key？选 Mock 提供商即可体验全流程。
            </p>
          </div>
        )}
        {entries.map(e => (
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
        ))}
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

/** 完成的回复用 markdown 渲染；流式中用纯文本（性能 + 光标贴合） */
function MarkdownView({ text }: { text: string }) {
  if (!text.trim()) return <span className="chat-msg__plain">（空回复）</span>;
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
