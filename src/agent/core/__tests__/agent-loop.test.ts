import { describe, expect, it } from "vitest";
import { runAgent, MAX_STEPS, type AgentEvent } from "../agent";
import { ToolRegistry, type AppServices } from "@/agent/tools/registry";
import type { ChatMessage, LLMProvider, StreamEvent, ToolCall } from "@/agent/providers/types";

/**
 * Agent 循环端到端测试（v0.9.0：补上"最大的测试盲区"）。
 *
 * 之前 loop 只有静态走读（learning/01），没有机械保证——这里用**脚本化 Provider**
 * （按预设剧本产出事件的假模型）驱动真实 ToolRegistry 跑完整循环，把核心决策
 * 全部钉进测试：
 * ① 终止判定是 `calls.length === 0` 而非 finish 事件（01 §4.3）；
 * ② 工具结果按协议回填（tool 消息紧跟其 assistant）并逐条 persist；
 * ③ 并发工具 allSettled：单个失败不拖垮整批，失败以 ok:false 回传给模型；
 * ④ MAX_STEPS 耗尽 → 透明的 hitMaxSteps 终答，不静默截断。
 *
 * 不 mock ToolRegistry：工具执行→结果 JSON 化→回填的链路是"协议正确性"本身，
 * 用真实 registry + 假工具才测得出来。services 用空壳（循环不触碰业务实现）。
 */

/** 脚本化 Provider：按剧本步进产出事件；剧本耗尽后重复最后一步（供 MAX_STEPS 测试）。
 *  requests 记录**快照**——runAgent 原地修改消息数组，存引用会看到最终态而非请求时刻。 */
function scriptedProvider(steps: Array<{ text?: string; calls?: ToolCall[] }>): LLMProvider & { requests: ChatMessage[][] } {
  let step = 0;
  return {
    id: "scripted",
    requests: [],
    async *chatStream(req) {
      this.requests.push([...req.messages]);
      const s = steps[Math.min(step, steps.length - 1)];
      step += 1;
      if (s.text) yield { type: "text-delta", text: s.text } satisfies StreamEvent;
      if (s.calls?.length) yield { type: "tool-calls", calls: s.calls } satisfies StreamEvent;
      yield { type: "finish", reason: s.calls?.length ? "tool_calls" : "stop" } satisfies StreamEvent;
    },
  };
}

/** 真实 registry + 两个假工具：一个恒成功，一个恒失败（验证 allSettled 隔离） */
function makeRegistry(): { registry: ToolRegistry; calls: Array<{ args: unknown }> } {
  const registry = new ToolRegistry();
  const calls: Array<{ args: unknown }> = [];
  registry.register({
    name: "echo_tool",
    description: "测试工具（成功）",
    parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
    risk: "read",
    async execute(args) {
      calls.push({ args });
      return { ok: true as const, data: { echoed: (args as { word: string }).word } };
    },
  });
  registry.register({
    name: "fail_tool",
    description: "测试工具（失败）",
    parameters: { type: "object", properties: {} },
    risk: "read",
    async execute() {
      throw new Error("工具内部炸了");
    },
  });
  return { registry, calls };
}

const ctx = { signal: new AbortController().signal, services: {} as unknown as AppServices };

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const call = (id: string, name: string, args: unknown): ToolCall => ({ id, name, arguments: JSON.stringify(args) });

describe("Agent 循环端到端（脚本化 Provider + 真实 ToolRegistry）", () => {
  it("一步终答：终止判定用 calls.length===0，文本增量逐条透传", async () => {
    const provider = scriptedProvider([{ text: "你好呀" }]);
    const events = await collect(runAgent({
      provider,
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "在吗" }],
      registry: makeRegistry().registry,
      ctx,
    }));
    expect(events.filter(e => e.type === "text-delta").map(e => (e as { text: string }).text)).toEqual(["你好呀"]);
    const done = events.at(-1)! as Extract<AgentEvent, { type: "done" }>;
    expect(done).toEqual({ type: "done", text: "你好呀", hitMaxSteps: false });
    // 没有工具调用 → 没有 step-end、没有 tool 消息落库
    expect(events.some(e => e.type === "step-end")).toBe(false);
  });

  it("工具轮次：结果按协议回填 + 逐条 persist + 增量透传终答", async () => {
    const provider = scriptedProvider([
      { calls: [call("t1", "echo_tool", { word: "锚点" })] },
      { text: "工具说：锚点" },
    ]);
    const { registry, calls } = makeRegistry();
    const persisted: ChatMessage[] = [];
    const events = await collect(runAgent({
      provider,
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "调用工具" }],
      registry,
      ctx,
      persist: m => persisted.push(m),
    }));

    // step-end 汇报工具成功
    const stepEnd = events.find(e => e.type === "step-end") as Extract<AgentEvent, { type: "step-end" }>;
    expect(stepEnd.step).toBe(0);
    expect(stepEnd.toolSummaries).toEqual([{ name: "echo_tool", ok: true }]);
    // 工具真的以解析后的参数执行了
    expect(calls).toEqual([{ args: { word: "锚点" } }]);
    // 终答
    const done = events.at(-1)! as Extract<AgentEvent, { type: "done" }>;
    expect(done.text).toBe("工具说：锚点");
    // 协议落库顺序：assistant(带 toolCalls) → tool(结果) → assistant(终答)
    expect(persisted.map(m => m.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(persisted[0]).toMatchObject({ role: "assistant", toolCalls: [call("t1", "echo_tool", { word: "锚点" })] });
    expect(persisted[1]).toMatchObject({ role: "tool", toolCallId: "t1", content: expect.stringContaining('"echoed":"锚点"') });
    // 第二轮请求里包含了回填的工具结果（协议连贯，模型能看到自己工具的输出）
    const secondTurn = provider.requests[1]!;
    expect(secondTurn[secondTurn.length - 1]).toMatchObject({ role: "tool", toolCallId: "t1" });
  });

  it("并发工具 allSettled：单个失败不拖垮整批，失败以 ok:false 回传", async () => {
    const provider = scriptedProvider([
      { calls: [call("a", "echo_tool", { word: "好" }), call("b", "fail_tool", {})] },
      { text: "部分成功" },
    ]);
    const { registry } = makeRegistry();
    const persisted: ChatMessage[] = [];
    const events = await collect(runAgent({
      provider,
      messages: [{ role: "user", content: "并发调用" }],
      registry,
      ctx,
      persist: m => persisted.push(m),
    }));
    const stepEnd = events.find(e => e.type === "step-end") as Extract<AgentEvent, { type: "step-end" }>;
    expect(stepEnd.toolSummaries).toEqual([{ name: "echo_tool", ok: true }, { name: "fail_tool", ok: false }]);
    // 两个工具消息都落库，失败的那条是 ok:false（模型据此向用户解释）
    const toolMsgs = persisted.filter(m => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0]!.content).toContain('"ok":true');
    expect(toolMsgs[1]!.content).toContain("工具内部炸了");
    expect((events.at(-1) as Extract<AgentEvent, { type: "done" }>).hitMaxSteps).toBe(false);
  });

  it("MAX_STEPS 耗尽：透明收尾（hitMaxSteps=true），不静默截断", async () => {
    // 模型永远在调工具：循环必须在 MAX_STEPS 步后如实收尾
    const provider = scriptedProvider([{
      calls: [call("loop", "echo_tool", { word: "又是工具" })],
    }]);
    const { registry } = makeRegistry();
    const events = await collect(runAgent({
      provider,
      messages: [{ role: "user", content: "无限工具" }],
      registry,
      ctx,
    }));
    const done = events.at(-1)! as Extract<AgentEvent, { type: "done" }>;
    expect(done.hitMaxSteps).toBe(true);
    expect(done.text).toContain("上限");
    // 步数精确：恰好 MAX_STEPS 次 step-end，不多不少
    expect(events.filter(e => e.type === "step-end")).toHaveLength(MAX_STEPS);
  });
});
