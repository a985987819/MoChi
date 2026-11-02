/**
 * remember 工具 —— 长期记忆写入入口。
 * 规格：docs/learning/04-memory.md §4.2（description 里的触发条件与禁区即提示词的一部分）。
 */

import type { ToolDefinition } from "./registry";

export function rememberTool(): ToolDefinition<{ fact: string }> {
  return {
    name: "remember",
    description:
      "记录一条关于用户的长期事实/偏好（如饮食偏好、工作作息、正在减脂）。" +
      "仅在用户明确要求记住（'记住…'），或信息明显长期有用时调用；" +
      "一次性的事（'明天要开会'）请用 add_todo。" +
      "不要记录密码、密钥、证件号等敏感信息。fact 必须主谓完整的独立一句话，" +
      "如：用户喜欢低糖饮食。",
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "一条独立事实，主谓完整" },
      },
      required: ["fact"],
    },
    risk: "write",
    async execute(args, ctx) {
      const id = await ctx.services.memory.remember(args.fact, "agent");
      return { ok: true as const, data: { id, message: "已记住" } };
    },
  };
}
