/**
 * 上下文组装 —— 规格：docs/learning/03-context-engineering.md §4.1。
 *
 * v0.5.0 泛化：buildInitialMessages → **buildMessages**（支持拼接协议历史）。
 * 层序 = 03 §2.1 预算表的顺序：system → 记忆注入 → 历史窗口 → 当前输入。
 * memories（v0.5 记忆检索）/ retrievedKnowledge（v0.6 RAG）作为 user 消息注入而非
 * 塞进 system：角色定义不被污染 + 符合 lost-in-the-middle 尾端优势（03 §2.2/§5）。
 */

import { SYSTEM_PROMPT } from "./prompt";
import type { ChatMessage } from "@/agent/providers/types";

export interface BuildContextInput {
  /** 协议历史（已过 trimWindow 裁剪） */
  history: ChatMessage[];
  userInput: string;
  /** v0.5.0：MemoryService.searchForContext(userInput) 的结果 */
  memories?: string[];
  /** v0.6.0：RAG 检索段 */
  retrievedKnowledge?: string;
  /** v0.7.0：当前时间（NL 提醒的时间解析锚点，learning/08 §5.2——模型不知道现在几点） */
  now?: Date;
}

export function buildMessages(input: BuildContextInput): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  if (input.memories?.length) {
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

  messages.push(...input.history);

  if (input.now) {
    // 当前时间注入（learning/08 §5.2）：模型不知道"现在几点"，相对时间（明早九点/
    // 半小时后）全靠这个锚点解析。放在最后一条 user 之前 = 尾端优势位置
    messages.push({ role: "user", content: `（当前时间：${formatCurrentTime(input.now)}）` });
  }

  messages.push({ role: "user", content: input.userInput });
  return messages;
}

/** "2026-11-03 21:05 周二，时区 UTC+8"（08 §5.2 格式） */
export function formatCurrentTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(d);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? "." + (abs % 60) / 60 * 10 : ""}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${weekday}，时区 ${offset}`;
}
