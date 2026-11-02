/**
 * BM25 检索器 —— 规格：docs/learning/05-rag-bm25.md §5.2（公式逐项讲解见 §3）。
 *
 * score(Q,d) = Σ IDF(t) · f(t,d)(k1+1) / ( f(t,d) + k1(1−b+b·|d|/avgdl) )
 * IDF(t) = ln( (N−n(t)+0.5)/(n(t)+1) + 1 )   ← Lucene 变体，恒为正
 *
 * 结构：倒排表 tf(term → docId → freq) + docLen + avgdl。
 * search 只遍历含查询词的文档（倒排的意义）——130 条毫秒级，长记忆列表同样够用。
 */

import type { RetrievedDoc, Retriever } from "./retriever";
import { tokenize } from "./tokenizer";

export class BM25Retriever implements Retriever {
  /** k1：TF 饱和度（越大高词频增益越大）；b：长度归一强度（0.75 = 短文档适度占优） */
  private k1 = 1.5;
  private b = 0.75;

  private docs = new Map<string, { text: string; meta?: Record<string, unknown> }>();
  /** 倒排表：term → (docId → 词频) */
  private tf = new Map<string, Map<string, number>>();
  private docLen = new Map<string, number>();
  private avgdl = 0;

  upsertDocument({ id, text, meta }: { id: string; text: string; meta?: Record<string, unknown> }): void {
    this.removeDocument(id); // 幂等
    const tokens = tokenize(text);
    this.docs.set(id, { text, meta });
    this.docLen.set(id, tokens.length);
    for (const t of tokens) {
      const posting = this.tf.get(t) ?? new Map<string, number>();
      posting.set(id, (posting.get(id) ?? 0) + 1);
      this.tf.set(t, posting);
    }
    this.recomputeAvgdl();
  }

  removeDocument(id: string): void {
    if (!this.docs.has(id)) return;
    const tokens = tokenize(this.docs.get(id)!.text);
    for (const t of tokens) {
      const posting = this.tf.get(t);
      if (posting) {
        posting.delete(id);
        if (posting.size === 0) this.tf.delete(t); // 收缩空倒排链
      }
    }
    this.docs.delete(id);
    this.docLen.delete(id);
    this.recomputeAvgdl();
  }

  search(query: string, topK: number): RetrievedDoc[] {
    const qTokens = [...new Set(tokenize(query))]; // 查询内去重：一个词重复问不加权
    const N = this.docs.size;
    const scores = new Map<string, number>();

    for (const t of qTokens) {
      const posting = this.tf.get(t);
      if (!posting) continue; // 全库未出现 → 该词无区分度，跳过
      const idf = Math.log((N - posting.size + 0.5) / (posting.size + 1) + 1);
      for (const [docId, f] of posting) {
        const dl = this.docLen.get(docId)!;
        const tf =
          (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * dl) / this.avgdl));
        scores.set(docId, (scores.get(docId) ?? 0) + idf * tf);
      }
    }

    return [...scores.entries()]
      .sort((a, b2) => b2[1] - a[1])
      .slice(0, topK)
      .map(([id, score]) => {
        const d = this.docs.get(id)!;
        return { id, score, text: d.text, meta: d.meta };
      });
  }

  private recomputeAvgdl(): void {
    const total = [...this.docLen.values()].reduce((a, n) => a + n, 0);
    this.avgdl = this.docLen.size === 0 ? 0 : total / this.docLen.size;
  }
}
