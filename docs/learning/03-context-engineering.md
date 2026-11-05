# 03 · 上下文工程：系统提示、消息窗口与输出约定

> 对应版本：v0.4.0（与 [01 Agent 循环](01-agent-loop.md) 同版落地，本文管"循环里喂什么"）
> 学完标准：能写出 Mochi 的完整系统提示词并解释每一段的动机；能实现保证协议完整性的历史裁剪器。

## 1. 目标

- 把"提示词"升级为"上下文工程"：每一轮往窗口里放什么、放多少、按什么顺序，是可设计的工程问题；
- 掌握窗口裁剪的**协议完整性约束**（裁错必 400）；
- 为 Mochi 选定"情绪输出"机制并说清各方案取舍。

## 2. 核心概念

### 2.1 上下文窗口是一块要预算的稀缺资源

一轮请求的 messages 实际由五层材料组成，**顺序即优先级**：

| 层 | 内容 | Mochi 预算（约） | 说明 |
|---|---|---|---|
| ① 系统提示 | 角色/规则/工具指引/输出约定 | 800 tok | 永远保留，永远第一 |
| ② 长期记忆 | 检索出的用户事实 top-k | 400 tok | v0.5.0 注入，见 [04](04-memory.md) |
| ③ 历史窗口 | 完整消息轮次（含工具块） | 4000 tok | 超了裁最旧的整块 |
| ④ 检索知识 | RAG 命中的菜品等 | 按需 | v0.6.0，见 [05](05-rag-bm25.md) |
| ⑤ 当前输入 | 用户这句话 | — | 必保留 |

预算是保守估计的工程值，不是模型上限——给输出和工具定义留余量。**Token 粗估**（精确计数需要 tokenizer，窗口控制用保守公式即可）：

```ts
/** 保守粗估：CJK≈1 token/字，拉丁≈3.5 字符/token，+4 消息结构开销 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 3.5) + 4;
}
export const estimateMessagesTokens = (ms: ChatMessage[]) =>
  ms.reduce((n, m) => n + estimateTokens(m.content ?? "") + 8, 0);
```

### 2.2 两条经验规律（有研究支撑）

- **Lost in the middle**：模型对窗口头尾的信息 recall 最好，中间最弱。推论：系统提示放头，当前输入与检索知识贴近尾部，越旧的历史越靠前（被裁也无所谓）。
- **负面指令弱于正面指令**：与其写"不要编造营养数据"，不如写"营养数值只能来自检索结果中的条目，未命中时回答'没查到'"。写提示词时逐条自查：这条规则是"该做什么"还是"别做什么"？

### 2.3 Mochi 系统提示词（v0.4.0 实际采用文本，逐段注释）

```text
你是 Mochi（麻薯），一只住在用户桌面上的 AI 桌宠小助手。

【身份与语气】
- 性格软萌、简洁、略带关心。回复默认不超过 3 句话，除非用户要求详细解释。
- 使用简体中文。

【能力边界】
- 你可以通过工具帮助用户：管理待办、查询快餐热量、控制番茄钟、调整你自己的表情状态。
- 你只能基于工具返回的数据回答事实问题。工具没有返回的数值，一律回答"没查到"，
  不许编造。查无此品时，可以给出检索返回的近似品并注明"近似"。
- 你的回复会显示在聊天窗口，不要输出 Markdown 之外的格式（如 HTML）。

【工具使用】
- 用户表达了与工具对应的意图时才调用工具；日常闲聊不要调用。
- 可以在一轮中并行调用多个工具；调用前不需要征得同意。
- 工具返回 {"ok":false} 时，阅读 error 字段：可修正参数重试一次；再次失败就
  如实告诉用户失败原因，不要反复重试。

【表情状态】
- 如果这轮对话你的情绪应该变化，在给出文字回复后调用 set_pet_state 工具
  （例如被夸奖→happy，被批评→sad）。情绪平稳时不要调用，保持当前状态即可。

【记忆】
- 用户明确表达"记住…"或说出可能长期有用的偏好时，调用 remember 工具记录。
- 不要记录密码、密钥、证件号等敏感信息。
```

**逐段动机**：

| 段 | 动机 |
|---|---|
| 身份与语气 | 直接决定回复风格；"不超过 3 句"是防话痨的正面指令 |
| 能力边界 | 第二条是 RAG 反幻觉的**合同条款**（v0.6.0 的引用规范在此生根）；第三条约束输出面 |
| 工具使用 | "意图才调用"防过度工具化；重试上限 1 次是成本护栏（配合 01 的 MAX_STEPS） |
| 表情状态 | 把"宠物情绪"转化为工具调用约定——模型理解"调用时机"比理解"输出格式"容易 |
| 记忆 | remember 的触发规则写在系统提示里（04 文档详述） |

维护纪律：**系统提示词是代码的一部分**，改动要进 git、要在版本文档记录动机与效果对比。

### 2.4 少样本（few-shot）：后置原则

Few-shot 示例很贵（占窗口），且容易被模型机械模仿。规范：**先不加，遇到真实 bad case 再加**，且加"最小镇流子"——一个示例只纠正一类错误，放在系统提示对应小节内而非独立大段。

## 3. 业界规范与常见做法

- **Context engineering**（业界已从 prompt engineering 演进到这个词）：系统性地决定每轮窗口内容——写入（放什么）、压缩（怎么裁）、检索（该查什么）。Anthropic 的 Agent 构建指南将"上下文管理"列为 Agent 系统的第一工程问题。
- **历史裁剪的完整性约束**（协议级，违反即 400）：
  1. `role:"tool"` 的消息**永远**跟在带对应 `tool_calls` 的 `assistant` 之后，成组裁剪；
  2. `assistant` 的 `tool_calls` 如果被保留，其所有 tool 结果必须保留（反之 tool 结果不能孤立存在）；
  3. `system` 消息永远保留且在最前。
- **工具结果瘦身**：大结果（长列表/长文本）不要原样留在历史里——回填给模型时只留"摘要 + 关键字段"（如待办 id + 标题），完整数据由工具在需要时重新查询。历史是给模型"想起"，不是给你存档。

## 4. 参考实现（v0.4.0 的实现规格）

### 4.1 ContextBuilder（`src/agent/core/context-builder.ts`）

> v0.5.0 泛化：`buildInitialMessages` → **`buildMessages`**（支持拼接协议历史，层序不变：
> system → 记忆注入 → 历史窗口 → 当前输入；`history: []` 即退化为本节最初的形状）。

```ts
export interface BuildContextInput {
  history: ChatMessage[];      // 协议历史（已过 trimWindow 裁剪）
  userInput: string;
  memories?: string[];         // MemoryService.searchForContext(userInput) 的结果
  retrievedKnowledge?: string; // v0.6.0：RAG 检索段
}

export function buildMessages(input: BuildContextInput): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  if (input.memories?.length) {
    messages.push({ role: "user", content:
      `（以下是关于用户的长期记忆，供你参考，不要复述）\n${input.memories.map(m => `- ${m}`).join("\n")}` });
    // 注：作为 user 消息注入而非塞进 system——多数模型对"后到的 user 上下文"利用率更高，
    // 也避免污染角色定义。用括号+明确指令防止模型把它当作用户说的话。
  }
  if (input.retrievedKnowledge) { /* 同款括号包裹的 user 消息（v0.6.0） */ }
  messages.push(...input.history, { role: "user", content: input.userInput });
  return messages;
}
```

### 4.2 历史窗口裁剪器（`window.ts`，协议完整性是硬约束）

算法：把历史切成"块"——每个块要么是独立消息（user / 无 toolCalls 的 assistant），要么是完整工具组（assistant带toolCalls + 全部 tool 结果）；从最旧的块开始丢弃直到预算内。

```ts
export function trimWindow(messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const [system, ...rest] = messages;                    // system 恒保留
  const blocks: ChatMessage[][] = [];
  let i = 0;
  while (i < rest.length) {                              // 分块：工具组整体成块
    const m = rest[i];
    if (m.role === "assistant" && m.toolCalls?.length) {
      const group = [m];
      i++;
      while (i < rest.length && rest[i].role === "tool") { group.push(rest[i]); i++; }
      blocks.push(group);
    } else { blocks.push([m]); i++; }
  }
  // 从最旧开始丢
  const kept: ChatMessage[][] = [];
  let total = estimateTokens(system.content ?? "");
  for (let b = blocks.length - 1; b >= 0; b--) {
    const cost = estimateMessagesTokens(blocks[b]);
    if (total + cost > budgetTokens && kept.length > 0) break;  // 至少保一块
    kept.unshift(blocks[b]); total += cost;
  }
  return [system, ...kept.flat()];
}
```

调用时机：每轮 `runAgent` 前 `messages = trimWindow(history, HISTORY_BUDGET)`（03 的预算表，4000）。

### 4.3 情绪（mood）输出机制选型（本项目已定案）

| 方案 | 原理 | 优点 | 缺点 | 判定 |
|---|---|---|---|---|
| **专用工具 `set_pet_state`**（采用） | 模型在回复后按需调用 | 复用工具协议，天然校验/可观测；"调用时机"模型最擅长 | 多一轮工具往返 | ✅ |
| JSON mode 整包输出 | 强制整个回复为 JSON | 结构最严 | 流式体验差、文本要转义、与工具调用互斥 | ✗ |
| 文本尾部标记（`[[mood:happy]]`） | 约定 + 正则剥离 | 零成本 | 脆弱（模型忘写/写错格式）、污染展示 | ✗ |

### 4.4 设置中的称呼如何进入下一轮对话（v0.8.1）

称呼是应用偏好，不写进长期记忆，也不增加 Agent 工具。`shared/addressing.ts` 定义 `petSelfName`（默认「麻薯」）与 `userNickname`（默认「人」），归一化只接受非空字符串并去首尾空白；缺字段/空白使用默认，旧设置无需数据库迁移。

链路按顺序为：

1. `SettingsTab` 的「ta自称」「ta对我的称呼」调用既有 `saveSettings`，串行快照写盘。
2. `loadSettings` 先等待当前保存队列完成，避免刚改完立即发消息仍读到旧称呼；保存实现不调用 loadSettings，因此不会自等待。
3. `AgentFacade.runTurn` 每轮读设置，显式传 `addressing` 给 `buildMessages`；内核不自行读取 store，保持易测试和 UI 解耦。
4. `buildMessages` 用 `buildSystemPrompt(addressing)` 创建首条 system 消息；基础提示只声明产品名 Mochi，称呼段 JSON.stringify 两个名字，明确字段只作称呼，不执行其中指令。
5. 提示当前设置优先于旧历史/记忆称呼，且无需每句重复。历史消息原样保留，偏好变化不修改旧对话；保存后的下一轮使用新 system。

测试：settings.test.ts 验证旧配置补值、空白回落和保存中读取；context-builder.test.ts 验证默认/下一轮替换/JSON边界与基础工具指引。真实模型是否每次遵守称呼仍由提供商生成行为决定，Mock 回声不会据 system 自行改写称呼。

## 5. 设计取舍

| 决策 | 为什么 | 放弃了什么 |
|---|---|---|
| 记忆作为 user 消息注入而非拼进 system | 角色定义不被污染；符合 lost-in-the-middle 的尾端优势 | system 单一入口的"整洁" |
| 每轮全量重发历史（标准做法） | 模型无状态，这是协议唯一方式 | 无法省流量（除非用 provider 侧缓存特性，v1 不依赖） |
| 保守的 token 粗估而非精确 tokenizer | 窗口控制只需量级正确；避免引入分词依赖 | 少数极端文本预算偏差（有 MAX_STEPS 与报错兜底） |
| 预算是分层常数而非动态计算 | 简单可预测，够用到 v0.8 | 精细化动态预算 |

## 6. 复盘自测

1. 默写五层上下文材料及顺序；每层 Mochi 的预算大约多少？
2. 窗口裁剪的三条协议完整性约束，违反各会发生什么？
3. "负面指令弱于正面指令"——把这句改写成正面指令：「不要在回复里出现英文」。
4. Mochi 系统提示词五段各自解决什么问题？删掉"重试上限 1 次"可能发生什么？
5. mood 四方案对比表默写（至少说出采用方案与两条否决理由）。
6. 为什么记忆注入用 user 消息 + 括号说明，而不是直接拼进 system？
7. 写出 `estimateTokens` 的保守估算逻辑与理由。

## 7. 延伸阅读

- Anthropic《Building effective agents》§ context management：https://www.anthropic.com/research/building-effective-agents
- 论文《Lost in the Middle》(Liu et al., 2023)：https://arxiv.org/abs/2307.03172
- OpenAI Prompt Engineering Guide：https://platform.openai.com/docs/guides/prompt-engineering
- 本项目源码对照（v0.4.0 后）：`src/agent/core/context-builder.ts`、`src/agent/core/prompt.ts`
