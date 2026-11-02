/**
 * Token 粗估与历史滑动窗口 —— 规格：docs/learning/03-context-engineering.md §2.1/§4.2。
 *
 * 窗口是**要预算的稀缺资源**（03 §2.1 五层预算表）；裁剪必须保协议完整性：
 * - system 恒保留且在最前；
 * - tool 消息永远跟在带对应 tool_calls 的 assistant 之后，**成块裁剪**；
 * - assistant 的 toolCalls 保留则其全部 tool 结果必须保留。
 */

import type { ChatMessage } from "@/agent/providers/types";

/** 保守粗估：CJK≈1 token/字，拉丁≈3.5 字符/token，+4 结构开销（03 §2.1；精确计数需 tokenizer，窗口控制只要量级正确） */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 3.5) + 4;
}

export const estimateMessagesTokens = (ms: ChatMessage[]): number =>
  ms.reduce((n, m) => n + estimateTokens(m.content ?? "") + 8, 0);

/** 03 §2.1 预算表：历史窗口层 */
export const HISTORY_BUDGET_TOKENS = 4000;

/**
 * 从最旧的**块**开始丢弃直到预算内（03 §4.2 算法原样实现）。
 * 块 = 独立消息（user/纯文本 assistant）或完整工具组（assistant 带 toolCalls + 全部 tool 结果）。
 */
export function trimWindow(messages: ChatMessage[], budgetTokens = HISTORY_BUDGET_TOKENS): ChatMessage[] {
  const [system, ...rest] = messages;
  if (!system || system.role !== "system") {
    // 防御：调用方保证首条是 system——违反约定直接原样返回（不静默造 system）
    return messages;
  }

  const blocks: ChatMessage[][] = [];
  let i = 0;
  while (i < rest.length) {
    const m = rest[i];
    if (m.role === "assistant" && m.toolCalls?.length) {
      const group: ChatMessage[] = [m];
      i++;
      // 收集该 assistant 的全部 tool 结果（判别收窄需取出元素再判断——TS 对
      // rest[i++] 这类下标表达式不做跨行窄化）
      while (i < rest.length) {
        const next = rest[i];
        if (next.role !== "tool") break;
        group.push(next);
        i++;
      }
      blocks.push(group);
    } else {
      blocks.push([m]);
      i++;
    }
  }

  const kept: ChatMessage[][] = [];
  let total = estimateTokens(system.content ?? "");
  for (let b = blocks.length - 1; b >= 0; b--) {
    const cost = estimateMessagesTokens(blocks[b]);
    if (total + cost > budgetTokens && kept.length > 0) break; // 至少保一块
    kept.unshift(blocks[b]);
    total += cost;
  }
  return [system, ...kept.flat()];
}
