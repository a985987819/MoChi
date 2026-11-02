/**
 * 上下文组装 —— 规格：docs/learning/03-context-engineering.md §4.1。
 *
 * v0.4.0：系统提示 + 用户输入（历史由 Facade 拼接）。
 * memories / retrievedKnowledge 两个入参是 v0.5.0（记忆检索注入）与 v0.6.0（RAG）
 * 的预留位——接口先立，届时 Facade 传入即可，本模块不用改（03 §4.1 的既定形状）。
 */

import { SYSTEM_PROMPT } from "./prompt";
import type { ChatMessage } from "@/agent/providers/types";

export interface ContextInput {
  userInput: string;
  /** v0.5.0：MemoryService.searchForContext(userInput) 的结果 */
  memories?: string[];
  /** v0.6.0：RAG 检索段 */
  retrievedKnowledge?: string;
}

export function buildInitialMessages(input: ContextInput): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  if (input.memories?.length) {
    // 记忆作为 user 消息注入而非塞进 system：角色定义不被污染，
    // 且符合 lost-in-the-middle 的尾端优势（03 §2.2/§5）
    messages.push({
      role: "user",
      content: `（以下是关于用户的长期记忆，供你参考，不要复述）\n${input.memories.map(m => `- ${m}`).join("\n")}`,
    });
  }
  if (input.retrievedKnowledge) {
    messages.push({
      role: "user",
      content: `（以下是检索到的参考资料，回答相关问题时只能引用这些条目）\n${input.retrievedKnowledge}`,
    });
  }
  messages.push({ role: "user", content: input.userInput });
  return messages;
}
