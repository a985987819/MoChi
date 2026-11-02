/**
 * 食物数据 → 检索文档 —— 规格：docs/learning/05-rag-bm25.md §5.3。
 *
 * 文档化决定"哪些字面会命中检索"：brand + name + aliases + category 拼接。
 * aliases 是召回率的生命线（"M记的麦辣鸡腿堡"靠 name bigram，"Big Mac"靠 alias）。
 * 数据集为手工整理约值（kcal/克，每份），来源为品牌公开营养数据；**宁缺勿编**。
 */

import type { RetrievedDoc } from "./retriever";

export interface FoodItem {
  id: string;
  brand: string;
  name: string;
  aliases: string[];
  category: string;
  serving: string;
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
  note?: string;
}

/** 数据集文件（三品牌分组；新增品牌 = 新 JSON 文件 + 此处一行 import） */
import mcd from "./data/food/mcd.json";
import kfc from "./data/food/kfc.json";
import others from "./data/food/others.json";

export const ALL_FOOD_ITEMS: FoodItem[] = [
  ...(mcd as FoodItem[]),
  ...(kfc as FoodItem[]),
  ...(others as FoodItem[]),
];

/** 文档化：决定 BM25 索引的字面。meta 挂原始条目，检索结果直接引用 */
export function foodToDoc(item: FoodItem): { id: string; text: string; meta: Record<string, unknown> } {
  return {
    id: item.id,
    text: [item.brand, item.name, ...item.aliases, item.category].join(" "),
    meta: { kind: "food", item },
  };
}

/** 从检索结果还原食物条目（meta 形状由 foodToDoc 保证） */
export function docToFood(doc: RetrievedDoc): FoodItem | null {
  const meta = doc.meta as { kind?: string; item?: FoodItem } | undefined;
  return meta?.kind === "food" ? (meta.item ?? null) : null;
}
