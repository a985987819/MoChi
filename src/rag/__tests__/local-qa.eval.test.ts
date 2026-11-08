import { describe, expect, it } from "vitest";
import { answerLocally, localKnowledgeSize } from "../local-qa";

/**
 * 本地问答路由评测（v0.9.0 健康问答扩展）。
 *
 * 两条边界的考卷：
 * ① 域内（康复/营养/膳食/热量）问题 → answered，且关键证据条目出现在回答文本中；
 * ② 域外问题（闲聊/编程/天气/写文章）→ out-of-scope（调用方据此引导连接大模型）。
 * 阈值（覆盖率 0.45 / 分数下限 1.0）改动必须重跑本文件——这是路由的合入门槛。
 */
const IN_DOMAIN: Array<{ q: string; expectId: string }> = [
  { q: "中风后应该怎么康复", expectId: "脑卒中（中风）康复" },
  { q: "腰椎间盘突出平时要注意什么", expectId: "腰椎间盘突出的康复原则" },
  { q: "崴脚了怎么处理", expectId: "扭伤急性处理" },
  { q: "肩周炎怎么锻炼", expectId: "肩周炎" },
  { q: "久坐办公室腰疼怎么办", expectId: "护腰" },
  { q: "每天蛋白质吃多少合适", expectId: "每天蛋白质吃多少" },
  { q: "痛风什么能吃什么不能吃", expectId: "高尿酸/痛风饮食要点" },
  { q: "缺钙怎么补", expectId: "补钙" },
  { q: "备孕要补叶酸吗", expectId: "叶酸" },
  { q: "老人肌肉流失怎么办", expectId: "老年营养" },
];

const OUT_DOMAIN = [
  "明天天气怎么样",
  "帮我写一首关于秋天的诗",
  "Python 虚拟环境怎么配",
  "推荐几部好看的电影",
  "最近有什么新闻",
  "你能帮我远程控制电脑吗",
];

describe("本地问答路由评测", () => {
  it("知识库规模符合预期（康复+营养并入健康索引）", () => {
    // 48（guidelines）+ 15（rehab）+ 16（nutrition）= 79；食物 100+79=179
    expect(localKnowledgeSize()).toMatch(/^79 条健康.*179 条食物/);
  });

  it.each(IN_DOMAIN.map(e => [e.q, e.expectId] as const))(
    "域内 → answered 且引用关键条目: %s",
    (q, expectId) => {
      const r = answerLocally(q);
      expect(r.kind).toBe("answered");
      if (r.kind === "answered") {
        expect(r.count).toBeGreaterThanOrEqual(1);
        expect(r.text).toContain(expectId);
        expect(r.text).toContain("来源："); // 引用合同：逐条带来源
        expect(r.text).toContain("⚠️"); // 面诊提示尾注
      }
    },
  );

  it.each(OUT_DOMAIN)("域外 → out-of-scope: %s", q => {
    expect(answerLocally(q).kind).toBe("out-of-scope");
  });

  it("路由召回率 ≥ 9/10（域内），误答率 = 0（域外）", () => {
    const hits = IN_DOMAIN.filter(e => answerLocally(e.q).kind === "answered").length;
    expect(hits).toBeGreaterThanOrEqual(9);
    const falsePositives = OUT_DOMAIN.filter(q => answerLocally(q).kind === "answered").length;
    expect(falsePositives).toBe(0);
  });
});
