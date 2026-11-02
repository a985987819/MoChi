/**
 * MemoryService —— 语义记忆（长期事实）：remember 写入 + BM25 检索注入。
 * 规格：docs/learning/04-memory.md §4.1~§4.2。
 *
 * 闭环纪律（04 §4.1"存了但查不到"）：**写记忆 = 落库 + 同步检索索引**，两动作必须绑定。
 * 索引在内存中随启动从表重建（数据量小，<10ms）——省掉索引持久化复杂度（04 §6）。
 * 检索与 RAG 共用 Retriever（05 §5.1）——一套代码两处收益。
 */

import { getDb } from "@/services/db";
import { BM25Retriever } from "@/rag/bm25";

export interface MemoryItem {
  id: number;
  fact: string;
  source: "user" | "agent";
  createdAt: number;
  updatedAt: number;
}

interface MemoryRow {
  id: number;
  fact: string;
  source: string;
  created_at: number;
  updated_at: number;
}

const DOC_PREFIX = "mem-";

export class MemoryService {
  private retriever = new BM25Retriever();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const db = await getDb();
    const rows = await db.select<MemoryRow[]>("SELECT id, fact, source, created_at, updated_at FROM memories ORDER BY id");
    for (const r of rows) {
      this.retriever.upsertDocument({ id: docId(r.id), text: r.fact });
    }
  }

  /** remember 工具的落点：**落库 + 索引 upsert 绑定**（拆开就是"存了但查不到"） */
  async remember(fact: string, source: "user" | "agent" = "user"): Promise<number> {
    const db = await getDb();
    const now = Date.now();
    const result = await db.execute(
      "INSERT INTO memories (fact, source, created_at, updated_at) VALUES ($1,$2,$3,$3)",
      [fact.trim(), source, now],
    );
    const id = result.lastInsertId as number;
    this.retriever.upsertDocument({ id: docId(id), text: fact.trim() });
    return id;
  }

  /** 每轮 context-builder 调用：与当前输入最相关的 top-k 事实原文 */
  async searchForContext(query: string, k = 3): Promise<string[]> {
    return this.retriever.search(query, k).map(h => h.text);
  }

  async list(): Promise<MemoryItem[]> {
    const db = await getDb();
    const rows = await db.select<MemoryRow[]>(
      "SELECT id, fact, source, created_at, updated_at FROM memories ORDER BY updated_at DESC",
    );
    return rows.map(r => ({
      id: r.id,
      fact: r.fact,
      source: r.source === "agent" ? "agent" : "user",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** 设置页删除单条（也是"用户对记忆有完全控制权"的落点，04 §5 隐私规范） */
  async remove(id: number): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM memories WHERE id = $1", [id]);
    this.retriever.removeDocument(docId(id));
  }
}

function docId(id: number): string {
  return `${DOC_PREFIX}${id}`;
}

/** 聊天窗单例 */
export const memoryService = new MemoryService();
