# 01 · Agent 循环与工具调用（编排层）

> 对应版本：v0.4.0 ｜ 前置：[02 传输层](02-provider-abstraction.md)（消费其 `LLMProvider` 与消息类型）
> 学完标准：能脱稿默写 Agent 循环的完整伪代码，并说清工具协议每个字段由谁生产、谁消费。

## 1. 目标

- 建立本系列最重要的一张图：**Agent = LLM + 循环 + 工具 + 状态**，去掉玄学；
- 吃透工具调用协议：声明（谁写）、触发（谁决定）、执行（谁跑）、回填（怎么喂回去）；
- 落地 `ToolRegistry` 与 `AgentRunner`，并处理真实世界的脏东西：参数不合法、工具抛错、死循环、用户中途停止。

## 2. 核心概念

### 2.1 Agent 的准确定义

> **Agent 是一个让 LLM 在循环中做决策的系统。** 每一轮：把对话历史交给模型 → 模型要么给出最终回答（结束），要么请求调用工具 → 你的代码执行工具 → 把结果作为新消息追加 → 回到第一步。

对比三个易混概念：

| | 谁控制流程 | 特征 |
|---|---|---|
| Chatbot | 用户 | 一问一答，无工具 |
| Workflow | **代码**（写死的步骤/分支） | 可靠但僵硬，LLM 只填空 |
| **Agent** | **模型**（在工具集内自主选择） | 灵活；循环轮数需你兜底 |

关键洞察：**控制流在代码手里，决策流在模型手里**。循环上限、工具白名单、结果格式都是你定的。

### 2.2 工具协议全字段（谁生产 → 谁消费）

```
工具声明（你写 → 发给模型看）
  tools[].function.name          工具名，蛇形命名，全局唯一
  tools[].function.description   给模型看的能力说明——写得好坏直接决定调用质量
  tools[].function.parameters    JSON Schema：参数协议

模型输出（模型写 → 你的代码消费）
  assistant.toolCalls[].id          本次调用的唯一 ID（回填时对号）
  assistant.toolCalls[].function.name       调哪个工具
  assistant.toolCalls[].function.arguments  参数 JSON 字符串（可能是残缺/非法 JSON！）

执行结果（你写 → 发回给模型看）
  role:"tool" + tool_call_id + content(字符串，约定 JSON)
```

三个高频错误源，提前打预防针：

1. `arguments` 是**字符串不是对象**（协议如此），且模型可能输出不合法 JSON——必须 try/catch；
2. `tool_call_id` 必须与请求时的 `id` 一一对应，漏一个多数 API 直接 400；
3. 模型会**幻觉出不存在的工具名**——不要抛异常崩溃，把错误作为 tool 结果回传，模型下一轮会自我纠正（这是 Agent 的自愈机制）。

### 2.3 ReAct：循环的思想原型

经典论文 *ReAct: Synergizing Reasoning and Acting in Language Models*（2022）确立了模式：

```
Thought:  用户想要明天的天气 → 我需要调用 weather 工具
Action:   weather({ "city": "北京" })
Observation: {"temp": "12℃", "cond": "晴"}
Thought:  已有答案
Answer:   北京明天 12℃，晴。
```

现代 function calling 把 `Action` 的"格式"问题交给协议（不再靠 prompt 约束文本格式），但 **Thought → Action → Observation 的循环骨架完全一致**。你实现的循环就是 ReAct 的工程化形态。

## 3. 业界规范与常见做法

- **工具描述是 prompt 的一部分**：`description` 要写"什么时候该用我 + 参数语义"，而不是复述函数名。业界共识：工具调用的准确率首先取决于描述质量，其次才是模型能力。
- **参数校验在代码侧，不在模型侧**：模型输出只是"建议"，JSON Schema 校验 + 默认值兜底是代码的责任。
- **错误回传而非抛出**：工具失败应作为 `role:"tool"` 的结果（`{"ok":false,"error":"…"}`）返回给模型，给它重试/换路的机会。只有致命错误（如用户主动中止）才终止循环。
- **并行 tool_calls**：现代模型可能一轮返回多个调用（`index` 0,1,2…）。互相独立的工具应并行执行（`Promise.allSettled`），结果按原顺序回填。
- **MCP（Model Context Protocol）一句话定位**：把"工具声明+执行"标准化为独立进程协议，让工具可跨应用复用。Mochi v1 不引入（工具是内置 TS 函数，无需跨进程），但架构上 `ToolRegistry` 与 MCP server 的能力面同构，未来可桥接。
- **循环上限是安全带**：生产 Agent 普遍设 max steps（5~20），防止模型陷入"调用-失败-重试"死循环烧钱。

## 4. 参考实现（v0.4.0 的实现规格）

### 4.1 工具注册表（`src/agent/tools/registry.ts`）

```ts
import type { ToolSpec, ToolCall } from "@/agent/providers/types";

/** 工具执行上下文：依赖注入的出口。内核不 import 任何业务模块 */
export interface ToolContext {
  signal: AbortSignal;
  services: AppServices;   // { todos: TodoService, pet: PetStateManager, memory: MemoryService, … }
}

export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: string };

export interface ToolDefinition<A = Record<string, unknown>> {
  name: string;
  description: string;                 // 写给模型：何时用 + 参数语义
  parameters: JsonSchemaObject;        // 写给模型：参数协议
  execute(args: A, ctx: ToolContext): Promise<ToolOutcome>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register<A>(tool: ToolDefinition<A>): void {
    if (this.tools.has(tool.name)) throw new Error(`工具重名: ${tool.name}`);
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
  }

  /** 发给模型的声明列表（02 的 ToolSpec 形状） */
  toSpecs(): ToolSpec[] {
    return [...this.tools.values()].map(t => ({
      name: t.name, description: t.description, parameters: t.parameters,
    }));
  }

  /** 统一执行入口：校验 → 执行 → 序列化。任何失败都不抛出，转为 ok:false 结果 */
  async execute(name: string, argsJson: string, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `未知工具: ${name}` };       // 幻觉工具 → 自愈入口
    let args: unknown;
    try { args = JSON.parse(argsJson || "{}"); }
    catch { return { ok: false, error: "参数不是合法 JSON" }; }
    const invalid = validateSchema(tool.parameters, args);
    if (invalid) return { ok: false, error: `参数校验失败: ${invalid}` };
    try { return await tool.execute(args as never, ctx); }
    catch (e) { return { ok: false, error: `执行异常: ${String(e)}` }; }
  }
}
```

### 4.2 迷你 JSON Schema 校验器（`validate-schema.ts`，~50 行）

只实现工具参数用得着的子集：`type` / `properties` / `required` / `enum` / `items` / `description`。生产项目可换 `ajv`，但手写一遍才知道校验器在干嘛。

```ts
export function validateSchema(schema: JsonSchemaObject, value: unknown): string | null {
  const err = (msg: string) => `${msg}（期望 ${JSON.stringify(schema)}，实际 ${JSON.stringify(value)}）`;
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return err("应为 object");
      for (const key of schema.required ?? [])
        if (!(key in value)) return err(`缺少必填字段 ${key}`);
      for (const [k, v] of Object.entries(value)) {
        const sub = schema.properties?.[k];
        if (sub) { const msg = validateSchema(sub, v); if (msg) return `${k}: ${msg}`; }
      }
      return null;
    }
    case "string": {
      if (typeof value !== "string") return err("应为 string");
      if (schema.enum && !schema.enum.includes(value)) return err(`应为 ${schema.enum.join("/")}`);
      return null;
    }
    case "number": return typeof value === "number" && Number.isFinite(value) ? null : err("应为 number");
    case "boolean": return typeof value === "boolean" ? null : err("应为 boolean");
    case "array": {
      if (!Array.isArray(value)) return err("应为 array");
      if (schema.items) for (const [i, v] of value.entries()) {
        const msg = validateSchema(schema.items as JsonSchemaObject, v); if (msg) return `[${i}]: ${msg}`;
      }
      return null;
    }
    default: return null; // 未知类型放行，交由工具内部兜底
  }
}
```

### 4.3 Agent 循环（`src/agent/core/agent.ts`，本系列的核心 60 行）

```ts
import type { ChatMessage, LLMProvider, ToolCall } from "@/agent/providers/types";

export const MAX_STEPS = 8;   // 安全带：防死循环烧钱

/** UI 消费的事件流：文本增量实时上屏，步骤完成驱动待办/宠物状态刷新 */
export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "step-end"; step: number; toolSummaries: Array<{ name: string; ok: boolean }> }
  | { type: "done"; text: string; hitMaxSteps: boolean };

export async function* runAgent(opts: {
  provider: LLMProvider;
  messages: ChatMessage[];        // 由 context-builder 组装好（03 文档）
  registry: ToolRegistry;
  ctx: ToolContext;
  signal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const { provider, registry, ctx } = opts;
  const messages = [...opts.messages];

  for (let step = 0; step < MAX_STEPS; step++) {
    // ── 1. 流式收本次回复 ──────────────────────────────
    let text = "";
    let calls: ToolCall[] = [];
    let finish: "stop" | "tool_calls" | "length" = "stop";
    for await (const ev of provider.chatStream({ messages, tools: registry.toSpecs() }, opts.signal)) {
      if (ev.type === "text-delta") { text += ev.text; yield { type: "text-delta", text: ev.text }; }
      else if (ev.type === "tool-calls") calls = ev.calls;
      else if (ev.type === "error") throw new Error(`[${ev.error.kind}] ${ev.error.message}`); // 传输层致命错误才终止
      else if (ev.type === "finish") finish = ev.reason;
    }

    // ── 2. 追加 assistant 消息（含 toolCalls 原样，协议要求）──
    messages.push({ role: "assistant", content: text || null, toolCalls: calls.length ? calls : undefined });

    // ── 3. 终止判定 ────────────────────────────────────
    if (calls.length === 0) { yield { type: "done", text, hitMaxSteps: false }; return; }

    // ── 4. 并发执行全部工具，按序回填 ────────────────────
    const settled = await Promise.allSettled(
      calls.map(c => registry.execute(c.name, c.arguments, ctx)),
    );
    calls.forEach((call, i) => {
      const r = settled[i];
      const outcome: ToolOutcome = r.status === "fulfilled"
        ? r.value
        : { ok: false, error: `工具内部异常: ${String(r.reason)}` };
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(outcome) });
    });
    yield { type: "step-end", step,
      toolSummaries: calls.map((c, i) => ({ name: c.name, ok: settled[i].status === "fulfilled" })) };
    // v0.5.0 起：此处同步把 messages 追加进 SQLite（重启可恢复到最近一步）
  }
  // 跑满 MAX_STEPS 仍未终止：直接收尾，避免无限循环
  yield { type: "done", text: "（任务过于复杂，已达到单次对话的工具调用上限）", hitMaxSteps: true };
}
```

> **v0.5.0 规格扩展**：`opts` 增加 `persist?(message: ChatMessage)` 回调——每次追加
> 协议消息（assistant/tool）时调用一次，由 HistoryStore 落库（04 §4.3）。循环本体
> 不感知存储，persist 缺省时行为与本节代码完全一致。

**逐段讲解**（每段都是面试级考点）：

- 第 2 步把 `assistant` 消息（含 `toolCalls`）压回历史：协议要求 tool 结果必须紧跟在带对应 `tool_calls` 的 assistant 消息之后，顺序不可乱；
- 第 3 步的终止条件是 `calls.length === 0`（而不是 `finish === "stop"`——带工具声明时模型说完了 finish 也是 stop，要看它是否发了调用）；
- 第 4 步 `Promise.allSettled`：单个工具拒绝不能拖垮整批；回填顺序必须与 `calls` 一致（对号入座靠 `toolCallId`）；
- `hitMaxSteps` 要如实告诉用户，而不是静默截断。

### 4.4 AgentFacade（内核与 UI 的接缝，`src/agent/facade.ts`）

UI 不直接调 `runAgent`，而是通过门面组装依赖（03 文档的 context-builder + 04 的记忆 + 本文的循环）：

```
用户输入 ─→ contextBuilder.build(input) ─→ runAgent(...) ─→ AgentEvent 流
                                                            ├─ text-delta → 聊天 UI
                                                            ├─ step-end   → 待办 Tab 刷新 / 宠物状态
                                                            └─ done       → 历史落库、输入解锁
```

门面持有：provider（按设置选择 DeepSeek/Mock）、registry（注册全部工具）、ctx（注入 services + signal）。**停止按钮 = `AbortController.abort()`**，循环内所有 await 点都会因 signal 抛出/短路，UI 收尾时把已生成的文本保留。

### 4.5 Mochi v0.4.0 工具清单（v0.6.0 再加 food-search）

| 工具 | 参数 | 行为 |
|---|---|---|
| `set_pet_state` | `state: string`（枚举）、`duration_sec?` | 驱动宠物情绪状态。**枚举经 08 §2 精化为 happy/sad**：thinking/talking 由应用从 AgentEvent 映射，alert/focus 等系统状态归应用计时器 |
| `add_todo` | `title: string`、`due?: string`（ISO 日期或自然语言原文） | 写入待办，返回 id |
| `list_todos` | `include_done?: boolean` | 返回 JSON 列表 |
| `complete_todo` | `id: number` | 标记完成 |
| `delete_todo` | `id: number` | 删除 |

`due` 允许模型直接传用户原话（"明天九点"），由 UI 展示原文——不做时间解析（v1 明确不做 NLP 时间抽取，避免幻觉具体时刻）。

## 5. 设计取舍

| 决策 | 为什么 | 放弃了什么 |
|---|---|---|
| 工具错误回传给模型而非抛出 | 模型能自我纠正（改参数重调/换工具/坦白失败） | 简单直接的全局报错 |
| 并行执行工具 | 一轮多调用是现代协议常态，串行浪费时延 | 无法表达"工具间依赖"——v1 假设工具互相独立（事实成立），未来需要时引入 `pending` 语义 |
| `MAX_STEPS=8` 硬上限 | 成本与死循环双保险 | 极长任务链（v1 场景不存在） |
| 工具结果统一 JSON 字符串 | 与 `role:"tool".content` 协议对齐，模型可读 | 无法回传图片等富内容（v1 工具集不需要） |
| 校验器手写 mini 版 | 看穿 JSON Schema 校验本质；零依赖 | ajv 的完整规范覆盖（format/pattern 等，需要时替换） |

## 6. 复盘自测（合上文档默写）

1. 默写 `runAgent` 的伪代码骨架（≤12 行：循环体四步 + 两个终止出口）。
2. 工具协议字段表：`name/description/parameters`、`id/name/arguments`、`tool_call_id/content` 分别谁生产、谁消费？
3. 为什么终止条件是 `calls.length === 0` 而不是 `finish_reason === "stop"`？
4. 模型幻觉调用 `delete_all_todos`（不存在的工具）时，循环层发生什么？模型下一轮能看到什么？
5. `Promise.allSettled` 而非 `Promise.all` 的理由？回填顺序为什么必须与 calls 一致？
6. 用户点"停止"后，哪些资源需要清理？已生成的文本去哪里？
7. `MAX_STEPS` 跑满时，对用户展示什么？
8. 为什么 `description` 是工具质量的第一决定因素？写两条好/坏 `description` 对比。

## 7. 延伸阅读

- ReAct 原论文（思想源头，值得精读 §2）：https://arxiv.org/abs/2210.03629
- OpenAI Function Calling Guide：https://platform.openai.com/docs/guides/function-calling
- DeepSeek Function Calling 教程（与本项目协议一致）：https://api-docs.deepseek.com/zh-cn/guides/function_calling
- Anthropic《Building effective agents》（workflow vs agent 的判据，业界引用最多）：https://www.anthropic.com/research/building-effective-agents
- MCP 官网（了解工具标准化生态方向）：https://modelcontextprotocol.io
