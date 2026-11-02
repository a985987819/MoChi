/**
 * 中文分词器 —— 规格：docs/learning/05-rag-bm25.md §4.2。
 *
 * bigram（相邻两字滑窗）方案：零依赖零词典，检索场景够用；
 * 局限（跨词噪声/语义改写召回差）由同义词表与评测集监控（05 §4.1 对比表）。
 * **查询与文档必须走同一函数**——分词不一致等于检索失效。
 */

const STOPWORDS = new Set([
  "的", "了", "吗", "呢", "吧", "啊", "我", "你", "他", "她", "它",
  "是", "在", "有", "和", "与", "多少", "热量", "卡路里", "什么", "怎么",
]); // 高频无区分词；"热量"几乎每条菜品文档都相关，切掉反而提纯

/** 中文 bigram + 拉丁/数字词元 + 停用词过滤 */
export function tokenize(text: string): string[] {
  const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
  const tokens: string[] = [];

  // 拉丁字母/数字连续串整体成词（BigMac、1/3 磅、26100 等）
  for (const m of norm.matchAll(/[a-z0-9]+(?:['.-][a-z0-9]+)*/g)) tokens.push(m[0]);

  // CJK 滑窗 bigram；单字串退化为 unigram
  for (const run of norm.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]+/g)) {
    const s = run[0];
    if (s.length === 1) {
      tokens.push(s);
      continue;
    }
    for (let i = 0; i < s.length - 1; i++) tokens.push(s.slice(i, i + 2));
  }

  return tokens.filter(t => !STOPWORDS.has(t));
}
