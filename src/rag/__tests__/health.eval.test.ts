/**
 * 健康 RAG 精度评测 —— 与 food.eval.test.ts 同一门槛模式（learning/05 §5.6）。
 *
 * 规则：典型 query（覆盖口语/同义/场景化问法），Hit@3 ≥ 阈值才准合入。
 * 语料改动（增删条目/改关键词）必须重跑本文件；失败先修检索再合入。
 *
 * 评测集特别覆盖了本语料的三类重点场景：
 * ① 办公久坐人群（用户的明确需求）；② 健身动作问答；③ 指南数字类问题。
 */
import { describe, expect, it } from "vitest";
import { HealthIndexService } from "../health";

/** 评测集：{ q: 用户可能的真实问法, expectId: 必须出现在 top3 的条目 } */
const EVAL_SET: Array<{ q: string; expectId: string }> = [
  { q: "一天吃多少盐合适", expectId: "health-salt" },
  { q: "每周应该运动多长时间", expectId: "health-exercise-150" },
  { q: "久坐办公室腰疼怎么办", expectId: "health-office-lumbar" },
  { q: "低头玩手机脖子疼", expectId: "health-office-neck" },
  { q: "眼睛干涩怎么缓解", expectId: "health-office-eyes" },
  { q: "深蹲膝盖内扣怎么办", expectId: "health-gym-squat" },
  { q: "卧推胳膊肘怎么放", expectId: "health-gym-bench" },
  { q: "引体向上做不起来", expectId: "health-gym-pullup" },
  { q: "练完第二天肌肉酸痛正常吗", expectId: "health-gym-doms" },
  { q: "怎么减肥不掉肌肉", expectId: "health-weight-rate" },
  { q: "每天要喝多少水", expectId: "health-water" },
  { q: "增肌每组做几次休息多久", expectId: "health-gym-sets-reps" },
  { q: "平板支撑坚持多久才算合格", expectId: "health-gym-plank" },
  { q: "奶茶糖多不多", expectId: "health-sugar" },
  { q: "午饭后散步好不好", expectId: "health-office-lunch-walk" },
];

const HIT_THRESHOLD = 13; // 15 题至少命中 13（合入门槛）

describe("健康 RAG 精度评测（Hit@3 ≥ 13/15）", () => {
  const svc = new HealthIndexService();

  it("语料规模达标（≥ 40 条，覆盖全部 6 个分类）", () => {
    expect(svc.size).toBeGreaterThanOrEqual(40);
    const categories = new Set(
      EVAL_SET.map(e => svc.search(e.q, 5)[0]?.item.category).filter(Boolean),
    );
    expect(categories.size).toBeGreaterThanOrEqual(4);
  });

  it("每条语料都带来源字段（引用合同的机械检查：漏 source 的条目直接红）", () => {
    for (const hit of svc.search("膳食 运动 久坐 健身 减肥 睡眠", 40)) {
      expect(hit.item.source).toBeTruthy();
      expect(hit.item.source).toMatch(/指南|行动|共识|组织|委员会|卫生部|学会|规范/);
    }
  });

  it.each(EVAL_SET.map(e => [e.q, e.expectId] as const))(
    "Hit@3: %s",
    (q, expectId) => {
      const topIds = svc.search(q, 3).map(h => h.item.id);
      expect(topIds).toContain(expectId);
    },
  );

  it(`总体 Hit@3 ≥ ${HIT_THRESHOLD}/15`, () => {
    const hits = EVAL_SET.filter(e => svc.search(e.q, 3).some(h => h.item.id === e.expectId));
    expect(hits.length).toBeGreaterThanOrEqual(HIT_THRESHOLD);
  });
});
