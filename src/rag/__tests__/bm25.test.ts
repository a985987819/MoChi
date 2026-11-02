/**
 * BM25 检索器单测 —— 规格来源：docs/learning/05-rag-bm25.md §3/§5.2。
 * 不验证公式数值本身，验证**排序行为**与生命周期语义（这正是检索质量的使用面）。
 */
import { describe, expect, it } from "vitest";
import { BM25Retriever } from "../bm25";

const upsert = (r: BM25Retriever, items: Array<[string, string]>) =>
  items.forEach(([id, text]) => r.upsertDocument({ id, text }));

describe("BM25Retriever", () => {
  it("精确命中的文档排在前面", () => {
    const r = new BM25Retriever();
    upsert(r, [
      ["a", "麦辣鸡腿堡 汉堡"],
      ["b", "板烧鸡腿堡 汉堡"],
      ["c", "可乐 饮料"],
    ]);
    const top = r.search("麦辣鸡腿堡", 3);
    expect(top[0]?.id).toBe("a");
    // 查询 bigram（麦辣/辣鸡/鸡腿/腿堡）只与 a、b 有交集；c 无任何公共词不召回
    expect(top).toHaveLength(2);
  });

  it("稀有词主导排序（IDF 直觉）", () => {
    const r = new BM25Retriever();
    upsert(r, [
      ["a", "套餐 可乐"],
      ["b", "巨无霸 可乐"],
      ["c", "巨无霸套餐 可乐"],
    ]);
    // "巨无霸"是稀有词（2/3 文档含），"可乐"处处有（IDF≈0）
    const top = r.search("巨无霸 可乐", 3);
    expect(["b", "c"]).toContain(top[0]?.id);
    expect(top[0]?.id).not.toBe("a");
  });

  it("查询内重复词不加权（去重）", () => {
    const r = new BM25Retriever();
    upsert(r, [
      ["a", "巨无霸"],
      ["b", "板烧"],
    ]);
    const once = r.search("巨无霸", 2).map(d => d.id);
    const twice = r.search("巨无霸 巨无霸", 2).map(d => d.id);
    expect(once).toEqual(twice);
  });

  it("未命中的查询返回空数组", () => {
    const r = new BM25Retriever();
    upsert(r, [["a", "巨无霸"]]);
    expect(r.search("披萨", 3)).toEqual([]);
    expect(r.search("", 3)).toEqual([]);
  });

  it("upsert 幂等：更新不产生重复计分", () => {
    const r = new BM25Retriever();
    r.upsertDocument({ id: "a", text: "巨无霸" });
    r.upsertDocument({ id: "a", text: "巨无霸" });
    expect(r.search("巨无霸", 3)).toHaveLength(1);
  });

  it("removeDocument 后不再召回", () => {
    const r = new BM25Retriever();
    upsert(r, [
      ["a", "巨无霸"],
      ["b", "板烧"],
    ]);
    r.removeDocument("a");
    const hits = r.search("巨无霸 板烧", 3);
    expect(hits.map(d => d.id)).toEqual(["b"]);
  });

  it("topK 截断生效", () => {
    const r = new BM25Retriever();
    upsert(r, [
      ["a", "汉堡一"],
      ["b", "汉堡二"],
      ["c", "汉堡三"],
    ]);
    expect(r.search("汉堡", 2)).toHaveLength(2);
  });
});
