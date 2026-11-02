/**
 * AgentRunner —— 本项目的核心 60 行：LLM ↔ 工具循环直至终答。
 * 规格：docs/learning/01-agent-loop.md §4.3（逐段讲解以规格为准，此处注释聚焦实现要点）。
 *
 * 终止条件是 `calls.length === 0` 而不是 finish==="stop"——带工具声明时模型说完
 * finish 也是 stop，要看它是否发了调用（01 §4.3 逐段讲解第 2 条）。
 * MAX_STEPS=8 是安全带：防"调用-失败-重试"死循环烧钱（01 §2.3 业界规范）。
 */

import type { ChatMessage, LLMProvider, ToolCall } from "@/agent/providers/types";
import type { ToolContext, ToolOutcome, ToolRegistry } from "@/agent/tools/registry";

export const MAX_STEPS = 8;

/** UI 消费的事件流：文本增量实时上屏，step-end 驱动待办/宠物状态刷新 */
export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "step-end"; step: number; toolSummaries: Array<{ name: string; ok: boolean }> }
  | { type: "done"; text: string; hitMaxSteps: boolean };

export async function* runAgent(opts: {
  provider: LLMProvider;
  /** 已组装好的初始消息（system + 记忆注入 + 历史 + 当前输入，见 context-builder/Facade） */
  messages: ChatMessage[];
  registry: ToolRegistry;
  ctx: ToolContext;
  signal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const { provider, registry, ctx } = opts;
  const messages = [...opts.messages];

  for (let step = 0; step < MAX_STEPS; step++) {
    // ── 1. 流式收本次回复 ──────────────────────────────────────
    let text = "";
    let calls: ToolCall[] = [];
    for await (const ev of provider.chatStream({ messages, tools: registry.toSpecs() }, opts.signal)) {
      if (ev.type === "text-delta") {
        text += ev.text;
        yield { type: "text-delta", text: ev.text };
      } else if (ev.type === "tool-calls") {
        calls = ev.calls;
      } else if (ev.type === "error") {
        // 传输层致命错误才终止循环（工具级失败走 ok:false 回传，见步骤 4）
        throw new Error(`[${ev.error.kind}] ${ev.error.message}`);
      }
      // finish 事件无需单独处理：以是否产生 tool_calls 为准
    }

    // ── 2. 追加 assistant 消息（协议要求：tool 结果必须紧跟 tool_calls 所在的 assistant）──
    messages.push({ role: "assistant", content: text || null, toolCalls: calls.length ? calls : undefined });

    // ── 3. 终止判定 ────────────────────────────────────────────
    if (calls.length === 0) {
      yield { type: "done", text, hitMaxSteps: false };
      return;
    }

    // ── 4. 并发执行全部工具，按序回填（allSettled：单个失败不拖垮整批）──
    const settled = await Promise.allSettled(calls.map(c => registry.execute(c.name, c.arguments, ctx)));
    calls.forEach((call, i) => {
      const r = settled[i];
      const outcome: ToolOutcome =
        r.status === "fulfilled" ? r.value : { ok: false, error: `工具内部异常: ${String(r.reason)}` };
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(outcome) });
    });
    yield {
      type: "step-end",
      step,
      toolSummaries: calls.map((c, i) => ({ name: c.name, ok: settled[i].status === "fulfilled" })),
    };
    // v0.5.0 起：此处把 messages 增量同步进 SQLite（重启可恢复到最近一步）
  }

  // 跑满 MAX_STEPS 仍未终止：如实收尾（01 §6 自测第 7 条——对用户透明，不静默截断）
  yield { type: "done", text: "（这个任务太复杂啦，单次对话的工具调用次数到上限了）", hitMaxSteps: true };
}
