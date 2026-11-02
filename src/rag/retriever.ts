/**
 * Retriever 接口 —— 规格：docs/learning/05-rag-bm25.md §5.1。
 *
 * **一套检索模块，两处收益**：长期记忆检索（learning/04 §4.1）与快餐热量 RAG
 * （learning/05）共用同一接口。v0.5.0 唯一实现是 BM25Retriever；
 * VectorRetriever 是第二个实现（接口已按"未来向量检索"的形状设计：
 * upsert/remove/search 三件套 + meta 挂原始数据）。
 */

export interface RetrievedDoc {
  id: string;
  text: string;
  score: number;
  meta?: Record<string, unknown>;
}

export interface Retriever {
  /** 写入或更新一个文档（幂等） */
  upsertDocument(doc: { id: string; text: string; meta?: Record<string, unknown> }): void;
  removeDocument(id: string): void;
  /** 返回按相关度降序的 topK 个文档 */
  search(query: string, topK: number): RetrievedDoc[];
}
