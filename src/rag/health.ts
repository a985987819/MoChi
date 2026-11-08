/**
 * HealthIndexService —— 权威健康/运动建议语料的检索服务（纯前端内存索引）。
 *
 * 与 FoodIndexService 同一管线形状（learning/05 §5）：构造即建索引（同步、
 * 数十条毫秒级）、expandQuery → BM25 top-k → 还原 HealthItem + score。
 * 语料来源是国家部委公开发布的指南要点（膳食指南/全民健身指南/健康中国行动），
 * 逐条带 source 字段——**模型引用时必须注明来源文件**，这是反幻觉合同的一半；
 * 另一半在工具 description 与系统提示词（见 health-search.ts / prompt.ts）。
 * 语料零持久化：随启动重建（learning/05 §6 既定裁决）。
 */

import { BM25Retriever } from "./bm25";
import { expandQuery } from "./synonyms";
import guidelines from "./data/health/guidelines.json";
import rehab from "./data/health/rehab.json";
import nutrition from "./data/health/nutrition.json";
import type { RetrievedDoc } from "./retriever";

/** 一条健康建议语料（来源字段是引用合同的兑现：模型必须能说出出处） */
export interface HealthItem {
  id: string;
  /** 检索面分类：膳食建议 / 日常运动 / 久坐与办公 / 健身训练 / 体重管理 / 特殊提示 */
  category: string;
  /** 建议标题（一句话可转述的结论） */
  title: string;
  /** 发布文件名 + 发布机构——引用时逐字展示给用户 */
  source: string;
  /** 建议正文（要点摘要，含具体数字；不含文件原文整段） */
  text: string;
  /** 召回扩展词（口语问法："鼠标手"→本条） */
  keywords: string[];
}

/** 语料集；扩充语料 = 新 JSON 文件 + 此处并一行 import。
 *  v0.9.0 健康问答扩展：guidelines（膳食/运动/久坐/健身）+ rehab（康复医学）+
 *  nutrition（临床营养）——后两者支撑无大模型的本地知识库问答（local-qa.ts）。 */
export const ALL_HEALTH_ITEMS: HealthItem[] = [
  ...(guidelines as HealthItem[]),
  ...(rehab as HealthItem[]),
  ...(nutrition as HealthItem[]),
];

/** 文档化：BM25 检索字面 = 分类 + 标题 + 召回词 + 正文（正文含用户口语词汇，如"膝盖内扣"） */
export function healthToDoc(item: HealthItem): { id: string; text: string; meta: Record<string, unknown> } {
  return {
    id: item.id,
    text: [item.category, item.title, ...item.keywords, item.text].join(" "),
    meta: { kind: "health", item },
  };
}

/** 从检索结果还原健康条目（meta 形状由 healthToDoc 保证） */
export function docToHealth(doc: RetrievedDoc): HealthItem | null {
  const meta = doc.meta as { kind?: string; item?: HealthItem } | undefined;
  return meta?.kind === "health" ? (meta.item ?? null) : null;
}

export interface HealthHit {
  item: HealthItem;
  /** BM25 原始分（保留两位供模型做相对置信判断） */
  score: number;
}

export class HealthIndexService {
  private retriever: BM25Retriever;
  readonly ready: Promise<void>;

  constructor(items: HealthItem[] = ALL_HEALTH_ITEMS) {
    this.retriever = new BM25Retriever();
    for (const item of items) {
      this.retriever.upsertDocument(healthToDoc(item));
    }
    this.ready = Promise.resolve();
  }

  /**
   * 检索健康建议条目。返回可能为空数组——**调用方（模型）必须据此回答
   * "没有对应建议条目"**，不允许编造指南条文或数字（learning/03 能力边界条款）。
   */
  search(rawQuery: string, topK = 5): HealthHit[] {
    const query = expandQuery(rawQuery);
    return this.retriever
      .search(query, topK)
      .map(doc => {
        const item = docToHealth(doc);
        return item ? { item, score: Math.round(doc.score * 100) / 100 } : null;
      })
      .filter((h): h is HealthHit => h !== null);
  }

  get size(): number {
    return ALL_HEALTH_ITEMS.length;
  }
}

/** 聊天窗单例（工具与未来 UI 共用） */
export const healthIndex = new HealthIndexService();
