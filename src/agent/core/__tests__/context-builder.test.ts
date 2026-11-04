import { describe, expect, it } from "vitest";
import { buildMessages, formatCurrentTime } from "../context-builder";
import type { ChatMessage } from "@/agent/providers/types";

/**
 * 上下文组装单测（施工单 §7.1：层序错 = 模型行为错）。
 * 断言 messages 的顺序与条数——03 §2.1 五层序：system → 记忆 → RAG → 历史 →
 * 时间锚点 → 当前输入。记忆/RAG/时间走 user 消息注入而非污染 system（03 §2.2）。
 */

const history: ChatMessage[] = [
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好呀" },
];

describe("buildMessages 层序", () => {
  it("最小输入：system + 当前输入两条", () => {
    const msgs = buildMessages({ history: [], userInput: "在吗" });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!).toEqual({ role: "user", content: "在吗" });
  });

  it("五层全量：system → 记忆 → RAG → 历史 → 时间锚点 → 当前输入", () => {
    const msgs = buildMessages({
      history,
      userInput: "帮我记一下",
      memories: ["用户喜欢低糖饮食"],
      retrievedKnowledge: "巨无霸 约550kcal",
      now: new Date(2026, 10, 4, 21, 30),
    });
    expect(msgs).toHaveLength(7); // 1 system + 1 记忆 + 1 RAG + 2 历史 + 1 时间 + 1 输入
    expect(msgs.map(m => m.role)).toEqual(["system", "user", "user", "user", "assistant", "user", "user"]);
    expect(msgs[1]!.content).toContain("长期记忆");
    expect(msgs[1]!.content).toContain("低糖饮食");
    expect(msgs[2]!.content).toContain("检索到的参考资料");
    expect(msgs[3]!).toEqual(history[0]); // 历史原样透传、不变形
    expect(msgs[4]!).toEqual(history[1]);
    expect(msgs[5]!.content).toContain("当前时间");
    expect(msgs[6]!.content).toBe("帮我记一下");
  });

  it("空 memories / 空 knowledge / 无 now 时对应层不出现", () => {
    const msgs = buildMessages({ history, userInput: "x", memories: [], retrievedKnowledge: "" });
    expect(msgs).toHaveLength(4); // system + 2 历史 + 输入
    expect(msgs.map(m => m.role)).toEqual(["system", "user", "assistant", "user"]);
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toBe("x");
  });

  it("记忆以列表行注入（每条一个 - 前缀）", () => {
    const msgs = buildMessages({
      history: [],
      userInput: "x",
      memories: ["事实A", "事实B"],
    });
    expect(msgs[1]!.content).toBe("（以下是关于用户的长期记忆，供你参考，不要复述）\n- 事实A\n- 事实B");
  });
});

describe("formatCurrentTime", () => {
  it("输出「YYYY-MM-DD HH:mm 周X，时区 UTC±…」格式（08 §5.2）", () => {
    const d = new Date(2026, 10, 4, 21, 5); // 本地时区的固定时刻
    const text = formatCurrentTime(d);
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[一二三四五六日]，时区 UTC[+-]/);
    // 日期部分与输入一致（用同一台机器的本地字段构造，跨时区稳定）
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(text).toContain(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    expect(text).toContain(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
  });
});
