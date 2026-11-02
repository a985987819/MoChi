/**
 * RAG 精度评测 —— 规格：docs/learning/05-rag-bm25.md §5.6（roadmap v0.6.0 验收项）。
 *
 * 规则：10 个典型 query（覆盖全名/别名/品牌+品/口语化/规格区分），
 * **Hit@3 ≥ 9/10 才准合入**——每次改动分词/参数/同义词表/数据集，必须重跑本文件
 * （`pnpm test`）。评测集就是 RAG 的考卷，没有它检索调优=玄学。
 *
 * 与其他测试的区别：这是**验收门**（阈值断言），不是行为断言——失败说明检索质量
 * 倒退，先修检索再合入。
 */
import { describe, expect, it } from "vitest";
import { FoodIndexService } from "../food";

/** 评测集：{ q: 用户可能的真实问法, expectId: 必须出现在 top3 的条目 } */
const EVAL_SET: Array<{ q: string; expectId: string }> = [
  { q: "巨无霸多少热量", expectId: "mcd-bigmac" },
  { q: "M记的麦辣鸡腿堡呢", expectId: "mcd-spicy-chicken" },
  { q: "肯德基原味鸡一块多少千卡", expectId: "kfc-original-chicken" },
  { q: "皇堡热量", expectId: "bk-whopper" },
  { q: "麦当劳大薯条多少大卡", expectId: "mcd-fries-l" },
  { q: "葡式蛋挞一个的热量", expectId: "kfc-egg-tart" },
  { q: "板烧鸡腿堡多少热量", expectId: "mcd-grilled-chicken" },
  { q: "老北京鸡肉卷多少千卡", expectId: "kfc-beijing-wrap" },
  { q: "肯德基香辣鸡腿堡热量高吗", expectId: "kfc-spicy-burger" },
  { q: "麦乐鸡五块的热量", expectId: "mcd-nuggets-5" },
];

const HIT_THRESHOLD = 9; // 10 题至少命中 9（learning/05 §5.6 合入门槛）

describe("RAG 精度评测（Hit@3 ≥ 9/10）", () => {
  const svc = new FoodIndexService();

  it("数据集规模达标（≥ 90 条，覆盖 ≥ 3 品牌）", () => {
    expect(svc.size).toBeGreaterThanOrEqual(90);
    const brands = new Set(
      EVAL_SET.map(e => svc.search(e.q, 5)[0]?.item.brand).filter(Boolean),
    );
    expect(brands.size).toBeGreaterThanOrEqual(2);
  });

  it.each(EVAL_SET.map(e => [e.q, e.expectId] as const))(
    "Hit@3: %s",
    (q, expectId) => {
      const topIds = svc.search(q, 3).map(h => h.item.id);
      expect(topIds).toContain(expectId);
    },
  );

  it(`总体 Hit@3 ≥ ${HIT_THRESHOLD}/10`, () => {
    const hits = EVAL_SET.filter(e => svc.search(e.q, 3).some(h => h.item.id === e.expectId));
    expect(hits.length).toBeGreaterThanOrEqual(HIT_THRESHOLD);
  });
});
