/**
 * trimWindow 单测 —— 规格来源：docs/learning/03-context-engineering.md §4.2。
 * 三条协议完整性约束 + 至少保一块 + 防御分支，全部是硬断言。
 */
import { describe, expect, it } from "vitest";
import { trimWindow, estimateTokens, HISTORY_BUDGET_TOKENS } from "../window";
import type { ChatMessage } from "@/agent/providers/types";

const sys: ChatMessage = { role: "system", content: "你是麻薯" };
const u = (c: string): ChatMessage => ({ role: "user", content: c });
const a = (c: string, toolCalls?: number): ChatMessage => ({
  role: "assistant",
  content: c,
  ...(toolCalls
    ? { toolCalls: Array.from({ length: toolCalls }, (_, i) => ({ id: `call_${i}`, name: "add_todo", arguments: "{}" })) }
    : {}),
});
const tool = (id: string): ChatMessage => ({ role: "tool", toolCallId: id, content: '{"ok":true}' });

describe("estimateTokens", () => {
  it("CJK 粗估约 1 token/字", () => {
    expect(estimateTokens("麻薯团")).toBe(3 + 4);
  });

  it("拉丁按 3.5 字符/token", () => {
    expect(estimateTokens("abcdefghij")).toBe(Math.ceil(10 / 3.5) + 4);
  });
});

describe("trimWindow", () => {
  it("预算充足时原样保留", () => {
    const msgs = [sys, u("你好"), a("你好呀")];
    expect(trimWindow(msgs, HISTORY_BUDGET_TOKENS)).toEqual(msgs);
  });

  it("超预算时丢弃最旧的块，system 恒保留", () => {
    const msgs = [sys, u("旧问题"), a("旧回答"), u("新问题"), a("新回答")];
    const trimmed = trimWindow(msgs, estimateTokens("你是麻薯") + estimateMessages(["新问题", "新回答"]) + 10);
    expect(trimmed[0]).toEqual(sys);
    expect(trimmed.some(m => m.content === "旧问题")).toBe(false);
    expect(trimmed.some(m => m.content === "新问题")).toBe(true);
  });

  it("约束②：tool 结果永远与其 assistant 同块保留或同块丢弃", () => {
    const msgs = [sys, u("旧问题"), a("", 1), tool("call_0"), u("新问题"), a("新回答")];
    const trimmed = trimWindow(msgs, estimateMessages(["新问题", "新回答"]) + estimateTokens("你是麻薯") + 10);
    const hasAssistantWithCalls = trimmed.some(m => m.role === "assistant" && m.toolCalls?.length);
    const hasTool = trimmed.some(m => m.role === "tool");
    // 两者必须共存亡：要么都在（旧块保留），要么都不在（旧块整体丢弃）
    expect(hasAssistantWithCalls).toBe(hasTool);
  });

  it("至少保一块（预算极小也不空转）", () => {
    const msgs = [sys, u("唯一一问"), a("唯一一答")];
    const trimmed = trimWindow(msgs, 1);
    expect(trimmed[0]).toEqual(sys);
    expect(trimmed.length).toBeGreaterThan(1);
  });

  it("首条非 system 时防御性原样返回", () => {
    const bad = [u("没有系统提示")] as ChatMessage[];
    expect(trimWindow(bad, 100)).toEqual(bad);
  });
});

function estimateMessages(contents: string[]): number {
  return contents.reduce((n, c) => n + estimateTokens(c) + 8, 0);
}
