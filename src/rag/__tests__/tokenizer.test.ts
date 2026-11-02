/**
 * tokenizer 单测 —— 规格来源：docs/learning/05-rag-bm25.md §4.2。
 * 查询与文档走同一函数，这里的断言就是"分词即协议"的锁定。
 */
import { describe, expect, it } from "vitest";
import { tokenize } from "../tokenizer";

describe("tokenize", () => {
  it("中文按 bigram 切分", () => {
    expect(tokenize("麦辣鸡腿堡")).toEqual(["麦辣", "辣鸡", "鸡腿", "腿堡"]);
  });

  it("拉丁/数字连续串整体成词并转小写", () => {
    expect(tokenize("Big Mac")).toEqual(["big", "mac"]);
    expect(tokenize("26100.0")).toEqual(["26100.0"]);
  });

  it("中英混排分别处理", () => {
    expect(tokenize("Big Mac 巨无霸")).toEqual(["big", "mac", "巨无", "无霸"]);
  });

  it("单字 CJK 退化为 unigram", () => {
    expect(tokenize("辣")).toEqual(["辣"]);
  });

  it("停用词被过滤（整词与 bigram 命中都过滤）", () => {
    // "多少热量" → 多少,少热,热量 → 多少/热量是停用词，仅剩"少热"
    expect(tokenize("多少热量")).toEqual(["少热"]);
  });

  it("空白归一（实现顺序：拉丁词元在前，CJK bigram 在后）", () => {
    expect(tokenize("  巨无霸   big ")).toEqual(["big", "巨无", "无霸"]);
  });

  it("文档分词保留重复词频（BM25 的 f(t,d) 依赖它）", () => {
    const tokens = tokenize("可乐可乐");
    expect(tokens).toEqual(["可乐", "乐可", "可乐"]);
    expect(tokens.filter(t => t === "可乐")).toHaveLength(2);
  });

  it("空串返回空数组", () => {
    expect(tokenize("")).toEqual([]);
  });
});
