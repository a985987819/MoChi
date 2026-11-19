/**
 * HistoryStore —— 情景记忆：协议历史持久化与恢复。
 * 规格：docs/learning/04-memory.md §4.3。
 *
 * 存协议原样（assistant.toolCalls JSON 整存、tool 结果原文）——恢复后可直接
 * 再发给 API（04 §4.3 设计回报）。
 *
 * v0.29.3：单会话（`main`）升级为**多会话历史**。sessions 表结构 v1 预留的
 * id/title/created_at 直接可用；当前会话 id 由本 Store 持有，ChatTab 负责列出/
 * 新建/切换。排序时间不新增列：`updated_at` 用消息表 MAX(created_at) 派生，
 * 避免"会话行要随每条消息更新"的额外写放大。
 */

import { getDb } from "@/services/db";
import type { ChatMessage, ToolCall } from "@/agent/providers/types";

/** 旧版本唯一会话 id：升级后作为"没有任何 sessions 行"时的兼容落点 */
export const MAIN_SESSION_ID = "main";
/** v1 单会话的默认标题（历史数据）：UI 展示时按当前自称动态翻译 */
export const LEGACY_MAIN_TITLE = "与麻薯的对话";
/** 新会话占位标题；首条用户消息落库后会被替换成内容摘要 */
export const NEW_SESSION_TITLE = "新对话";
const TITLE_MAX_CHARS = 24;

/** 会话摘要（ChatTab 的历史下拉列表） */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  /** 最后一条消息时间（空会话回落创建时间），列表按它倒序 */
  updatedAt: number;
}

interface MessageRow {
  id: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
}

export class HistoryStore {
  /** 当前会话 id；null = 尚未解析（启动后由 ensureActive 选最近一条或建新） */
  private currentId: string | null = null;
  private ensuring: Promise<string> | null = null;

  /**
   * 选出当前会话：
   * 1. 已有 currentId → 直接用（ChatTab 切换后保持）；
   * 2. 否则取最近创建的一条；
   * 3. 一条都没有 → 建 `main`（兼容旧库 / 全新安装）。
   */
  private async ensureActive(): Promise<string> {
    if (this.currentId) return this.currentId;
    if (this.ensuring) return this.ensuring;
    this.ensuring = (async () => {
      const db = await getDb();
      const rows = await db.select<Array<{ id: string }>>(
        "SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1",
      );
      if (rows[0]?.id) return rows[0].id;
      await db.execute("INSERT OR IGNORE INTO sessions (id, title, created_at) VALUES ($1, $2, $3)", [
        MAIN_SESSION_ID,
        NEW_SESSION_TITLE,
        Date.now(),
      ]);
      return MAIN_SESSION_ID;
    })()
      .then(id => {
        this.currentId = id;
        return id;
      })
      .finally(() => {
        this.ensuring = null;
      });
    return this.ensuring;
  }

  async getCurrentSessionId(): Promise<string> {
    return this.ensureActive();
  }

  /** 历史下拉列表：按最近活动倒序（空会话用创建时间兜底） */
  async listSessions(): Promise<SessionSummary[]> {
    const db = await getDb();
    const rows = await db.select<
      Array<{ id: string; title: string; created_at: number; updated_at: number }>
    >(
      `SELECT s.id, s.title, s.created_at,
              COALESCE(MAX(m.created_at), s.created_at) AS updated_at
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id, s.title, s.created_at
        ORDER BY updated_at DESC`,
    );
    return rows.map(row => ({
      id: row.id,
      title: row.title || NEW_SESSION_TITLE,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** 切换会话；id 必须存在（防 UI 传脏 id 后写入孤儿消息） */
  async setCurrentSession(id: string): Promise<void> {
    const db = await getDb();
    const rows = await db.select<Array<{ id: string }>>("SELECT id FROM sessions WHERE id = $1", [id]);
    if (!rows[0]) throw new Error("会话不存在");
    this.currentId = id;
  }

  /** 新建会话并切过去；标题先用占位，首条用户消息后自动摘要 */
  async createSession(title: string = NEW_SESSION_TITLE): Promise<SessionSummary> {
    const db = await getDb();
    const id = crypto.randomUUID();
    const now = Date.now();
    const safeTitle = title.trim() || NEW_SESSION_TITLE;
    await db.execute("INSERT INTO sessions (id, title, created_at) VALUES ($1, $2, $3)", [
      id,
      safeTitle,
      now,
    ]);
    this.currentId = id;
    return { id, title: safeTitle, createdAt: now, updatedAt: now };
  }

  /**
   * 追加队列：persist 是 fire-and-forget（agent.ts `void historyStore.append`），
   * 若直接并发执行两条 INSERT，SQLite 异步桥可能让 tool 消息先于其 assistant 落库——
   * 协议顺序破坏后恢复即 400。串行化队列保证落库顺序 = 追加顺序。
   * 吞掉错误（记录不致命），避免未处理 rejection；队列不被毒化（catch 在链内）。
   */
  private queue: Promise<void> = Promise.resolve();

  append(messages: ChatMessage[]): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        if (messages.length === 0) return;
        const sessionId = await this.ensureActive();
        await this.appendTo(sessionId, messages);
      })
      .catch(e => console.error("[HistoryStore] 落库失败（不阻塞队列）:", e));
    return this.queue;
  }

  private async appendTo(sessionId: string, messages: ChatMessage[]): Promise<void> {
    const db = await getDb();
    const now = Date.now();
    for (const m of messages) {
      await db.execute(
        "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          sessionId,
          m.role,
          m.content ?? null,
          m.role === "assistant" && m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.role === "tool" ? m.toolCallId : null,
          now,
        ],
      );
    }
  }

  /**
   * 追加用户消息，**与末尾相同的重复输入跳过**（v0.27.0 会话丢失修复 + 重试兼容）。
   *
   * 背景：runAgent 只持久化 assistant/tool——用户输入从不落库，重启后对话只剩
   * 麻薯的单口相声（会话丢失的直接根因）。去重是给重试路径兜底：失败重试会
   * 重发同一输入，末尾相同则跳过，避免历史里出现两条一模一样的用户消息。
   *
   * v0.29.3：会话内首条用户消息会顺手把占位标题改成内容摘要（≤24 字）。
   */
  async appendUserDeduped(content: string): Promise<void> {
    const db = await getDb();
    const sessionId = await this.ensureActive();
    const last = await db.select<Array<{ role: string; content: string | null }>>(
      "SELECT role, content FROM messages WHERE session_id = $1 ORDER BY id DESC LIMIT 1",
      [sessionId],
    );
    if (last[0]?.role === "user" && last[0]?.content === content) return;

    const counts = await db.select<Array<{ n: number }>>(
      "SELECT COUNT(*) AS n FROM messages WHERE session_id = $1",
      [sessionId],
    );
    const isFirstMessage = (counts[0]?.n ?? 0) === 0;

    await this.append([{ role: "user", content }]);
    if (isFirstMessage) {
      await db.execute("UPDATE sessions SET title = $1 WHERE id = $2", [
        summarizeTitle(content),
        sessionId,
      ]);
    }
  }

  /** 最近 N 个块（默认 12）——ChatTab 挂载/Facade 组上下文共用 */
  async loadRecent(blockCount = 12): Promise<ChatMessage[]> {
    const db = await getDb();
    const sessionId = await this.ensureActive();
    const rows = await db.select<MessageRow[]>(
      "SELECT role, content, tool_calls, tool_call_id FROM messages WHERE session_id = $1 ORDER BY id ASC",
      [sessionId],
    );
    const all = rows.map(rowToMessage);
    if (all.length === 0) return [];

    // 分块（03 §4.2 规则）：assistant(带 tool_calls) + 其后所有 tool 消息 = 一块
    const blocks: ChatMessage[][] = [];
    let i = 0;
    while (i < all.length) {
      const m = all[i];
      if (m.role === "assistant" && m.toolCalls?.length) {
        const group: ChatMessage[] = [m];
        i++;
        while (i < all.length) {
          const next = all[i];
          if (next.role !== "tool") break;
          group.push(next);
          i++;
        }
        blocks.push(group);
      } else {
        blocks.push([m]);
        i++;
      }
    }
    return blocks.slice(-blockCount).flat();
  }

  /** 清空当前会话的消息（会话行保留） */
  async clear(): Promise<void> {
    const db = await getDb();
    const sessionId = await this.ensureActive();
    await db.execute("DELETE FROM messages WHERE session_id = $1", [sessionId]);
  }

  /** 设置页「清空聊天历史」：删除全部消息与会话，并新建一个干净会话 */
  async clearAll(): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM messages");
    await db.execute("DELETE FROM sessions");
    this.currentId = null;
    await this.ensureActive();
  }
}

/** 用户首条消息 → 会话标题：压平空白、截断，空内容回落占位标题 */
function summarizeTitle(content: string): string {
  const line = content.replace(/\s+/g, " ").trim();
  if (!line) return NEW_SESSION_TITLE;
  return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS)}…` : line;
}

function rowToMessage(r: MessageRow): ChatMessage {
  if (r.role === "assistant") {
    const toolCalls: ToolCall[] = r.tool_calls ? JSON.parse(r.tool_calls) : [];
    return {
      role: "assistant",
      content: r.content,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }
  if (r.role === "tool") {
    return { role: "tool", toolCallId: r.tool_call_id ?? "", content: r.content ?? "" };
  }
  return { role: r.role, content: r.content ?? "" };
}

/** 聊天窗单例 */
export const historyStore = new HistoryStore();
