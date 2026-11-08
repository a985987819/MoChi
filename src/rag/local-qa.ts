/**
 * LocalQA —— 本地知识库问答路由（v0.9.0 健康问答扩展）。
 *
 * 用户需求的两条边界：
 * ① 康复科/营养学科（及既有的膳食/运动/热量域）问题 → **不经过大模型**，
 *    直接本地检索组装回答（离线可用、零成本、毫秒级）；
 * ② 范围之外的问题 → 明确告知"需要连接大模型"，并给出连接路径。
 *
 * # 为什么置信判定不用 BM25 分数阈值
 *
 * BM25 分数是**语料库相对值**（IDF 随库变化），跨库、跨语料规模都不可比。
 * 这里改用可解释的信号——**查询词元覆盖率**：查询的内容词元（分词去停用词）
 * 有多大比例被 top 文档覆盖。覆盖率高 = 文档确实在"说这个问题"，而非只是
 * 沾边。再叠加 top1 分数下限过滤长查询沾边的垃圾命中。
 *
 * # 与 Agent 的关系（learning/07 边界）
 *
 * 大模型已连接时**不走本地路由**——模型带着工具（search_health_advice/search_food）
 * 的完整对话质量更高，本地路由只在没有 LLM 时兜底。判定权在调用方
 * （ChatTab 按 isProviderReady 分流），本模块只回答"能不能答"。
 */

import { tokenize } from "./tokenizer";
import { healthIndex } from "./health";
import { foodIndex } from "./food";

/** 置信覆盖阈值：查询内容词元被 top 文档覆盖的比例下限 */
const COVERAGE_THRESHOLD = 0.45;
/** top1 分数下限：过滤"长查询里个别词沾边"的弱命中 */
const MIN_TOP_SCORE = 1.0;
/** 组装回答时最多引用的条目数（读得完，来源可核对） */
const MAX_CITED = 3;

export interface LocalAnswer {
  kind: "answered";
  /** 引用条目数（1~MAX_CITED） */
  count: number;
  /** 组装好的 Markdown 回答（逐条带来源 + 面诊提示尾注） */
  text: string;
}

export type LocalQAResult =
  | LocalAnswer
  | { kind: "out-of-scope" };

/** 组装用统一视图：health 条目与 food 条目抹平成「标题/正文/来源」 */
interface Evidence {
  title: string;
  body: string;
  source: string;
}

/**
 * 虚词字符：bigram 窗口跨词切出的碎片（"炎怎"/"么锻"/"酸吗"）永远不可能被文档
 * 覆盖——它们不是语义单元，是分词的副产品。覆盖率计算前把含这些字符的查询
 * bigram 从分母剔除（只影响本模块的置信判定，不动全局 tokenizer/BM25）。
 */
const FUNCTION_CHARS = "的了吗呢吧啊嗯哦啥什样我你他她它是在有和与很太不没还又再才就这那都也被把让给向往从对跟或及怎么哪要能会上下里外也于其此为作但而则即只更最每约";

/** 查询侧词元：剔除含虚词字符的 bigram，保留实义词元（痛风/叶酸/锻炼…） */
function contentTokens(query: string): string[] {
  return [...new Set(tokenize(query))].filter(
    t => !(t.length === 2 && [...t].some(ch => FUNCTION_CHARS.includes(ch))),
  );
}

/** 检索两库取证据；覆盖判定在查询词元 ∪ top 文档词元上做 */
function gatherEvidence(query: string): { evidence: Evidence[]; topScore: number; coverage: number } | null {
  const healthHits = healthIndex.search(query, 4);
  const foodHits = foodIndex.search(query, 3);
  const topScore = Math.max(healthHits[0]?.score ?? 0, foodHits[0]?.score ?? 0);
  if (topScore === 0) return null;

  const evidence: Evidence[] = [
    ...healthHits.map(h => ({
      title: h.item.title,
      body: h.item.text,
      source: h.item.source,
    })),
    ...foodHits.map(h => ({
      title: `${h.item.name}（${h.item.serving}）`,
      body: `约 ${h.item.kcal} kcal，蛋白质 ${h.item.protein}g、脂肪 ${h.item.fat}g、碳水 ${h.item.carbs}g${h.item.note ? `。${h.item.note}` : ""}`,
      source: "内置食物热量数据集",
    })),
  ];

  // 覆盖率：查询实义词元（虚词碎片已剔除，见 contentTokens）出现在 top 文档词元集的比例
  const topTexts = [
    ...healthHits.slice(0, 3).map(h => `${h.item.title} ${h.item.keywords.join(" ")} ${h.item.text}`),
    ...foodHits.slice(0, 2).map(h => `${h.item.name} ${h.item.aliases.join(" ")} ${h.item.category}`),
  ];
  const docTokens = new Set(topTexts.flatMap(t => tokenize(t)));
  const queryTokens = contentTokens(query);
  const covered = queryTokens.filter(t => docTokens.has(t)).length;
  const coverage = queryTokens.length ? covered / queryTokens.length : 0;

  return { evidence, topScore, coverage };
}

/** 判定 + 组装：域内有可信证据 → answered（Markdown 逐条带来源）；否则 out-of-scope */
export function answerLocally(query: string): LocalQAResult {
  const gathered = gatherEvidence(query);
  if (!gathered) return { kind: "out-of-scope" };
  const { evidence, topScore, coverage } = gathered;
  if (topScore < MIN_TOP_SCORE || coverage < COVERAGE_THRESHOLD) {
    return { kind: "out-of-scope" };
  }

  const cited = evidence.slice(0, MAX_CITED);
  const lines = cited.map(
    (e, i) => `${i + 1}. **${e.title}**\n   ${e.body}\n   （来源：${e.source}）`,
  );
  const sourceCount = new Set(cited.map(e => e.source)).size;
  const tail = sourceCount > 1 ? `\n\n以上共参考 ${sourceCount} 份来源。` : "";

  return {
    kind: "answered",
    count: cited.length,
    text:
      `我从本地知识库里找到了 ${cited.length} 条相关内容：\n\n${lines.join("\n\n")}${tail}\n\n` +
      `⚠️ 以上是公开发布指南与权威数据的科普摘要，不能替代医师、康复师或临床营养师的面诊评估；涉及疾病请先就医。`,
  };
}

/** 供设置页/引导文案展示：本地知识库规模 */
export function localKnowledgeSize(): string {
  return `${healthIndex.size} 条健康/康复/营养知识 + ${foodIndex.size} 条食物热量数据`;
}

/** 类型守卫：判别 answered 结果（调用方据此走本地回答分支） */
export function isLocalAnswer(r: LocalQAResult): r is LocalAnswer {
  return r.kind === "answered";
}
