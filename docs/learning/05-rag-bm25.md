# 05 · RAG 与 BM25：快餐热量查询的检索管线

> 对应版本：v0.6.0 ｜ 前置：[01 循环](01-agent-loop.md)（food-search 是一个工具）、[04 记忆](04-memory.md)（共用 Retriever）
> 学完标准：能默写 BM25 公式并解释每个参数；能独立实现 bigram 分词 + 倒排索引 + 打分检索 + 评测脚本。

## 1. 目标

- 建立 RAG 的完整管线视角：**加载 → 文档化 → 索引 → 检索 → 注入/引用 → 生成**，检索质量决定回答质量；
- 亲手实现 BM25（本系列最硬核的算法段），理解每个参数的直觉；
- 用中文 bigram 分词解决"没有分词器依赖"的检索；
- 建立 RAG 评测习惯：没有评测集的检索 = 玄学。

## 2. 核心概念

### 2.1 RAG 解决什么问题

LLM 的两个缺陷：**知识截止**（训练后的事不知道）与**幻觉**（不知道也会编）。RAG（Retrieval-Augmented Generation）的解法：回答前先从外部知识库检索相关内容，**把"依据"放进上下文**，让模型基于依据作答。Mochi 的场景：营养数据集是我们手工整理的，模型训练数据里必然不全不准——"巨无霸多少千卡"必须走检索，**数值只能来自检索命中的条目**（03 系统提示的能力边界条款）。

### 2.2 Mochi 的管线全景

```
离线（启动时，毫秒级）：
  food/*.json ─→ 文档化（name+aliases+brand+category 拼接） ─→ 分词 ─→ 倒排索引 + docLen/avgdl
在线（每次查询）：
  用户问题 ─→ 同义词扩展 ─→ 分词 ─→ BM25 打分 top-k ─→ 结果 JSON ─→ 模型生成带引用回答
```

**本项目不切块**：每条菜品就是一个小文档（~30 token）。切块（chunking）是长文档 RAG 的课题，这里数据天然是结构化小文档——**认清数据形态再套管线**，本身就是重要的工程判断。

### 2.3 为什么 BM25 起步（算一笔账）

| 方案 | 适配度 | 成本 |
|---|---|---|
| BM25 + 别名表 | 130 条 × 关键词明显的查询（品名/品牌/别名），召回足够 | 零依赖、零 API 费、毫秒级、完全离线 |
| 向量检索（embedding） | 语义改写型查询更优（"想吃点辣的"） | 需 embedding 模型（**DeepSeek 不提供**，本地 ONNX +30~80MB 或再配一个云 API） |
| 混合（BM25+向量 RRF 融合） | 最佳 | 两套基础设施 |

结论：**先 BM25，`Retriever` 接口留好，向量方案是它的第二个实现**——不是"以后推翻重来"。

## 3. BM25 原理（逐项吃透）

BM25（Best Matching 25）是 TF-IDF 的工程改进版，对文档 d 关于查询 Q 打分：

```
score(Q, d) = Σ_{t ∈ Q}  IDF(t) · TF(t, d)

TF(t, d)  = f(t,d) · (k1 + 1) / ( f(t,d) + k1 · (1 − b + b · |d| / avgdl) )
IDF(t)    = ln( (N − n(t) + 0.5) / (n(t) + 1) + 1 )          ← Lucene 变体，恒为正
```

| 符号 | 含义 | 直觉 |
|---|---|---|
| `f(t,d)` | 词 t 在文档 d 中的出现次数 | 出现越多越相关，**但有饱和** |
| `k1`（1.2~2.0，默认 1.5） | TF 饱和度 | k1 越大，高词频的边际增益越大；k1=0 时只看"出现与否" |
| `b`（默认 0.75） | 长度归一强度 | b=1 完全按长度惩罚长文档；b=0 不归一。短文档占优是检索经验规律 |
| `\|d\| / avgdl` | 文档长度 / 平均长度 | 长文档分母变大 → 分数被压 |
| `N` / `n(t)` | 文档总数 / 含 t 的文档数 | IDF：越稀有的词越有区分度（"麦辣" >> "的"）；+1 防零与负 |

**三条直觉检验理解**：
1. 查询词在文档出现 3 次 vs 1 次——分数更高，但不到 3 倍（饱和曲线）；
2. 一个 500 字的"巨无霸"长文 vs 一个 30 字的条目都含"巨无霸"——短条目分数更高（b 的作用）；
3. "套餐"几乎每条都有 → IDF≈0，对排序几乎无贡献（稀有词主导排序）。

## 4. 中文分词：bigram 方案

### 4.1 为什么选 bigram（二元切分）

中文没有空格。专业分词（jieba 等）需要词典+依赖；而**检索场景下 bigram（相邻两字滑窗）是够用的经典替代**：

```
"麦辣鸡腿堡" → ["麦辣","辣鸡","鸡腿","腿堡"]   （补充 unigram 可选：["麦","辣","鸡",…]）
"Big Mac 巨无霸" → ["big","mac","巨无","无霸"]
```

- 优点：零依赖、实现 10 行、查询与文档同样切分则必然有公共 bigram（"巨无霸" 查 "巨无霸套餐" 命中）；
- 局限：跨词组合引入噪声（"辣鸡"）、语义改写召回差（"汉堡" vs "堡"）→ 用**同义词表**补；
- 对比：单字 unigram 召回广但排序噪声大；jieba 精准但引依赖+词典——**v1 用 bigram，接口不变将来可换**。

### 4.2 参考实现（`src/rag/tokenizer.ts`）

```ts
const STOPWORDS = new Set(["的", "了", "吗", "呢", "吧", "啊", "我", "你", "他",
  "是", "在", "有", "和", "与", "多少", "热量", "卡路里"]);   // 高频无区分词；"热量"每条都相关，切掉反而提纯

/** 中文 bigram + 拉丁/数字词元；查询与文档必须走同一函数 */
export function tokenize(text: string): string[] {
  const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
  const tokens: string[] = [];
  // 拉丁字母/数字连续串整体成词（品名里的 BigMac、1/3 磅等）
  for (const m of norm.matchAll(/[a-z0-9]+(?:['.-][a-z0-9]+)*/g)) tokens.push(m[0]);
  // CJK 滑窗 bigram
  const cjkRuns = norm.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]+/g);
  for (const run of cjkRuns) {
    const s = run[0];
    if (s.length === 1) { tokens.push(s); continue; }        // 单字串退化为 unigram
    for (let i = 0; i < s.length - 1; i++) tokens.push(s.slice(i, i + 2));
  }
  return tokens.filter(t => !STOPWORDS.has(t));
}
```

## 5. 参考实现（v0.6.0 的实现规格）

### 5.1 Retriever 接口（`src/rag/retriever.ts`，记忆与 RAG 共用）

```ts
export interface RetrievedDoc { id: string; text: string; score: number; meta?: Record<string, unknown>; }

export interface Retriever {
  upsertDocument(doc: { id: string; text: string; meta?: Record<string, unknown> }): void;
  removeDocument(id: string): void;
  search(query: string, topK: number): RetrievedDoc[];
}
// 未来第二个实现：VectorRetriever（embedding 接口：embed(texts: string[]): Promise<number[][]>，
// 相似度 = 余弦；混合检索 = BM25 与向量各自 top-k 后按 RRF 融合：score = Σ 1/(60+rank)）
```

### 5.2 BM25 检索器（`src/rag/bm25.ts`，核心 ~70 行）

```ts
export class BM25Retriever implements Retriever {
  private k1 = 1.5; private b = 0.75;
  private docs = new Map<string, { tokens: string[]; meta?: Record<string, unknown> }>();
  private tf = new Map<string, Map<string, number>>();   // term → (docId → freq)  倒排表
  private docLen = new Map<string, number>();
  private avgdl = 0;

  upsertDocument({ id, text, meta }) {
    this.removeDocument(id);                              // 幂等
    const tokens = tokenize(text);
    this.docs.set(id, { tokens, meta });
    this.docLen.set(id, tokens.length);
    for (const t of tokens) {
      const posting = this.tf.get(t) ?? new Map();
      posting.set(id, (posting.get(id) ?? 0) + 1);
      this.tf.set(t, posting);
    }
    this.avgdl = [...this.docLen.values()].reduce((a, n) => a + n, 0) / this.docLen.size;
  }

  search(query: string, topK: number): RetrievedDoc[] {
    const qTokens = [...new Set(tokenize(query))];        // 查询内去重：一个词重复问不加权
    const N = this.docs.size;
    const scores = new Map<string, number>();
    for (const t of qTokens) {
      const posting = this.tf.get(t);
      if (!posting) continue;                             // 查询词全库未出现 → 跳过（IDF≈0）
      const idf = Math.log((N - posting.size + 0.5) / (posting.size + 1) + 1);
      for (const [docId, f] of posting) {                 // 只遍历含该词的文档（倒排的意义）
        const dl = this.docLen.get(docId)!;
        const tf = f * (this.k1 + 1) / (f + this.k1 * (1 - this.b + this.b * dl / this.avgdl));
        scores.set(docId, (scores.get(docId) ?? 0) + idf * tf);
      }
    }
    return [...scores.entries()]
      .sort((a, b2) => b2[1] - a[1])
      .slice(0, topK)
      .map(([id, score]) => ({ id, score, text: this.textOf(id), meta: this.docs.get(id)!.meta }));
  }
}
```

### 5.3 数据集与文档化（`src/rag/data/food/*.json` + `indexer.ts`）

条目形状（首发 ~130 条：麦当劳 ~50、肯德基 ~40、汉堡王/必胜客/塔斯汀 ~40）：

```json
{
  "id": "mcd-bigmac",
  "brand": "麦当劳",
  "name": "巨无霸",
  "aliases": ["Big Mac", "bigmac", "巨无霸汉堡"],
  "category": "汉堡",
  "serving": "1 个（约 219g）",
  "kcal": 550, "protein": 25, "fat": 32, "carbs": 44,
  "note": "数值为约值，以官方公示为准"
}
```

```ts
/** 文档化：决定"哪些字面会命中检索"。aliases 是召回率的生命线 */
export function foodToDoc(item: FoodItem) {
  return {
    id: item.id,
    text: [item.brand, item.name, ...item.aliases, item.category].join(" "),
    meta: { kind: "food", item },     // 原始条目挂在 meta，工具结果直接引用
  };
}
```

### 5.4 同义词表（`synonyms.ts`，查询扩展）

```ts
/** 组内任意词出现，则把组内所有词并入查询（并集扩展） */
const SYNONYM_GROUPS = [
  ["巨无霸", "big mac", "bigmac"],
  ["麦辣鸡腿堡", "麦辣堡", "spicy chicken burger"],
  ["可乐", "coke", "cola"],
  ["薯条", "fries"],
  ["汉堡", "burger", "堡"],
  ["热量", "千卡", "大卡", "kcal", "卡路里"],   // 口语归一
];
export function expandQuery(query: string): string {
  let q = query.toLowerCase();
  for (const group of SYNONYM_GROUPS)
    if (group.some(w => q.includes(w))) q += " " + group.join(" ");
  return q;
}
```

查询扩展（改查询）比索引扩展（改文档）便宜且不影响存储——规范：**优先查询侧**。

### 5.5 food-search 工具（接进 Agent）

```ts
registry.register({
  name: "search_food",
  description: "查询常见快餐品牌（麦当劳/肯德基/汉堡王等）菜单条目的热量与营养。返回最相关的条目列表。回答营养数值时只能引用返回条目中的数据，未命中就如实说没查到。",
  parameters: { type: "object",
    properties: { query: { type: "string", description: "菜名或描述，可含品牌，如：麦当劳 巨无霸" },
                  top_k: { type: "number", description: "返回条数，默认 5" } },
    required: ["query"] },
  execute: async (args, ctx) => {
    const hits = ctx.services.food.search(args.query, args.top_k ?? 5);
    return { ok: true, data: hits.map(h => ({ ...h.meta.item, score: Math.round(h.score * 100) / 100 })) };
  },
});
```

模型拿到的是**原始条目 JSON**（含 id/name/serving/kcal），回答时按系统提示要求引用品名与份量。检索发生在工具里（agentic RAG）：模型自己决定"问什么"，检索质量好时模型连"要不要检索"都不会问错。

### 5.6 评测（`src/rag/__tests__/bm25.eval.ts`）——RAG 必须有考卷

```ts
const EVAL_SET: Array<{ q: string; expectId: string }> = [
  { q: "巨无霸多少热量",        expectId: "mcd-bigmac" },
  { q: "M记的麦辣鸡腿堡",      expectId: "mcd-spicy-chicken" },   // 口语别名
  { q: "kfc 原味鸡 一块",       expectId: "kfc-original" },
  { q: "香辣鸡腿堡热量高吗",    expectId: "kfc-spicy-burger" },
  { q: "taco 铃的牛肉塔可",     expectId: "taco-beef" },
  // …共 10 条，覆盖：全名命中 / 别名 / 品牌+品 / 口语化 / 无检索词干扰
];
/** 断言：top3 内必须出现 expectId（ Hit@3 ≥ 9/10 才准合入） */
```

规范：**每次改动分词/参数/同义词表，跑一遍评测集**。检索是无 ground truth 也能低成本验收的少数算法环节——别放弃这个优势。

## 6. 设计取舍

| 决策 | 为什么 | 放弃了什么 |
|---|---|---|
| BM25 起步 + Retriever 接口 | 数据量级小、关键词查询为主、零成本零依赖 | 语义改写查询的召回（同义词表缓解；向量方案是第二实现） |
| bigram 而非 jieba | 零依赖零词典，检索够用；接口隔离可替换 | 跨词噪声（评测集监控） |
| 索引内存重建 | 130 条毫秒级，免持久化复杂度 | 大语料启动速度 |
| 查询扩展优于索引扩展 | 改查询即时生效、不动存储 | 扩展词不进文档导致 IDF 波动（影响可忽略） |
| topK=5 给模型 | 覆盖歧义（"鸡腿堡"两个品牌都有）又不过载窗口 | 更高 topK 的边际召回（劣质低分项反而干扰生成） |
| 检索作为工具（agentic RAG）而非每轮强制注入 | 模型自主判断何时需要；闲聊不浪费检索 | 模型忘记调用（系统提示+工具描述双重引导缓解） |
| 健康域复用同一管线（v0.9.0） | HealthIndexService 与 FoodIndexService 同形状：换语料不换检索 | 健康问答的语义改写召回（同法缓解）；**引用合同**（source 字段+eval 机械检查）是健康域特有约束——通用 RAG 可不带 |
| 同义词组的触发词取"查询里真实会出现的子串" | health eval 复盘：目标词被隔开时（"要喝多少水"）bigram 切不出"喝水"，文档侧堆关键词救不了查询侧 | 触发词过泛（如单字"喝"）会把扩展词带给少量无关查询——无命中即无噪声，代价可忽略 |

## 7. 复盘自测

1. 默写 BM25 的 TF 与 IDF 公式；`k1`、`b` 各控制什么？取默认值多少？
2. 为什么 IDF 用 Lucene 变体（+1）？朴素 IDF 什么情况下出负数？
3. bigram 的两条局限是什么？分别用什么手段缓解？
4. 倒排索引的三个数据结构（tf/docLen/avgdl）各存什么？`search` 里"只遍历含查询词的文档"对应哪个结构？
5. 文档化时 `aliases` 为什么重要？写一个数据集条目的完整 JSON。
6. 查询扩展 vs 索引扩展的取舍理由？
7. 评测集断言什么指标？合入门槛是多少？什么改动必须重跑评测？
8. 检索结果给模型时带 `score` 有什么用？（提示：模型可在多候选间做相对判断并在回答中体现置信度）

## 8. 延伸阅读

- BM25 原论文 *Okapi BM25*（Robertson & Zaragoza）：https://doi.org/10.1561/1500000019
- Lucene BM25Similarity 文档（工业实现参考，IDF 变体出处）：https://lucene.apache.org/core/9_0_0/core/org/apache/lucene/search/similarities/BM25Similarity.html
- 《Introduction to Information Retrieval》ch.11（免费教材，概率检索模型）：https://nlp.stanford.edu/IR-book/
- jieba-wasm（将来换精确分词的现成选项）：https://github.com/yanyiwu/nodejieba
- 本项目源码对照（v0.6.0 后）：`src/rag/`、`src/rag/data/food/`、`src/rag/__tests__/`
