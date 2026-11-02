/**
 * FoodIndexService —— 热量数据集的检索服务（纯前端内存索引）。
 *
 * 构造即建索引（同步、100 条毫秒级）——没有异步 init，因此 ready 恒就绪，
 * 与 TodoService/MemoryService 的 ready 门统一形状（facade 统一等待，见 v0.5.0 完善）。
 * 检索管线：expandQuery（同义词扩展）→ BM25 top-k → 还原 FoodItem + score。
 * 数据与索引零持久化：随启动重建（learning/05 §6 既定裁决）。
 */

import { BM25Retriever } from "./bm25";
import { ALL_FOOD_ITEMS, docToFood, foodToDoc, type FoodItem } from "./indexer";
import { expandQuery } from "./synonyms";

export interface FoodHit {
  item: FoodItem;
  /** BM25 原始分（保留两位供模型做相对置信判断） */
  score: number;
}

export class FoodIndexService {
  private retriever: BM25Retriever;
  readonly ready: Promise<void>;

  constructor(items: FoodItem[] = ALL_FOOD_ITEMS) {
    this.retriever = new BM25Retriever();
    for (const item of items) {
      const doc = foodToDoc(item);
      this.retriever.upsertDocument(doc);
    }
    this.ready = Promise.resolve();
  }

  /**
   * 检索食物条目。返回可能为空数组——**调用方（模型）必须据此回答"没查到"**，
   * 不允许编造数值（learning/03 系统提示词能力边界条款）。
   */
  search(rawQuery: string, topK = 5): FoodHit[] {
    const query = expandQuery(rawQuery);
    return this.retriever
      .search(query, topK)
      .map(doc => {
        const item = docToFood(doc);
        return item ? { item, score: Math.round(doc.score * 100) / 100 } : null;
      })
      .filter((h): h is FoodHit => h !== null);
  }

  get size(): number {
    return ALL_FOOD_ITEMS.length;
  }
}

/** 聊天窗单例（工具与未来 UI 共用） */
export const foodIndex = new FoodIndexService();
