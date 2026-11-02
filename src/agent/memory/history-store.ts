/**
 * HistoryStore —— 情景记忆：协议历史持久化与恢复。
 * 规格：docs/learning/04-memory.md §4.3。
 *
 * 存协议原样（assistant.toolCalls JSON 整存、tool 结果原文）——恢复后可直接
 * 再发给 API（04 §4.3 设计回报）。v1 单会话（sessions.id='main'）。
 *
 * 恢复策略：loadRecent 取最近 N 个**块**（块 = 独立消息 或 assistant+其全部 tool
 * 结果的完整组，learning/03 §4.2 分块规则）——块完整性是协议硬约束。
 */

import { getDb } from "@/services/db";
import type { ChatMessage, ToolCall } from "@/agent/providers/types";

export const MAIN_SESSION_ID = "main";

interface MessageRow {
  id: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
}

export class HistoryStore {
  /** 幂等建会话行（sessions 表 v1 只此一行） */
  async ensureSession(): Promise<void> {
    const db = await getDb();
    await db.execute("INSERT OR IGNORE INTO sessions (id, title, created_at) VALUES ($1, $2, $3)", [
      MAIN_SESSION_ID,
      "与麻薯的对话",
      Date.now(),
    ]);
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
      .then(() => this.doAppend(messages))
      .catch(e => console.error("[HistoryStore] 落库失败（不阻塞队列）:", e));
    return this.queue;
  }

  private async doAppend(messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.ensureSession();
    const db = await getDb();
    const now = Date.now();
    for (const m of messages) {
      await db.execute(
        "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          MAIN_SESSION_ID,
          m.role,
          m.content ?? null,
          m.role === "assistant" && m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.role === "tool" ? m.toolCallId : null,
          now,
        ],
      );
    }
  }

  /** 最近 N 个块（默认 12）——ChatTab 挂载/Facade 组上下文共用 */
  async loadRecent(blockCount = 12): Promise<ChatMessage[]> {
    const db = await getDb();
    const rows = await db.select<MessageRow[]>(
      "SELECT role, content, tool_calls, tool_call_id FROM messages WHERE session_id = $1 ORDER BY id ASC",
      [MAIN_SESSION_ID],
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

  /** 设置页「清空聊天历史」——只清消息，会话行保留 */
  async clear(): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM messages WHERE session_id = $1", [MAIN_SESSION_ID]);
  }
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
