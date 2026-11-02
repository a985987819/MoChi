# 02 · Provider 抽象：OpenAI 兼容协议与 SSE 流式（传输层）

> 对应版本：v0.3.0 ｜ 前置：[00 总览](00-learning-path.md) 的前置知识自检
> 学完标准：能从零写出一个可对接 DeepSeek/Kimi/硅基流动的流式客户端，并说清 SSE 解析的每个分支。

## 1. 目标

- 把"调用大模型"还原成它本来的样子：**一个 HTTP 接口**，没有魔法；
- 逐字节理解 SSE 流式协议（尤其 `tool_calls` 增量拼接——最高频的坑）；
- 设计 `LLMProvider` 抽象：换提供商 = 换配置，不是换代码。

## 2. 核心概念

### 2.1 Chat Completions：模型的"函数签名"

剥掉所有 SDK 包装，一次对话补全是这样的 HTTP 调用：

```
POST {baseURL}/chat/completions
Authorization: Bearer {apiKey}
Content-Type: application/json

{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system",  "content": "你是麻薯…" },
    { "role": "user",    "content": "帮我记个待办" },
    { "role": "assistant", "content": null,
      "tool_calls": [ { "id": "call_1", "type": "function",
        "function": { "name": "add_todo", "arguments": "{\"title\":\"买牛奶\"}" } } ] },
    { "role": "tool", "tool_call_id": "call_1", "content": "{\"ok\":true}" }
  ],
  "tools": [ { "type": "function", "function": {
      "name": "add_todo",
      "description": "添加一条待办",
      "parameters": { "type": "object", "properties": { "title": { "type": "string" } },
                      "required": ["title"] } } } ],
  "stream": true
}
```

三个必须刻进脑子的认知：

1. **模型无状态**。上文全靠 `messages` 数组每次全量重发；服务端不记得你。
2. **模型只会"说"**。它不能执行任何东西——所谓"调用工具"，是它输出一段结构化 JSON 表示"我想调 add_todo"，**执行方是你的代码**。
3. `role` 只有四种：`system` / `user` / `assistant` / `tool`。工具结果用 `role:"tool"` + `tool_call_id` 对号入座。

### 2.2 SSE：流式的行式协议

`stream: true` 时响应是 `text/event-stream`，本体就是一段长文本，按行解析：

```
data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"好"},"finish_reason":null}]}

data: {"id":"x","choices":[{"index":0,"delta":{"content":"的"},"finish_reason":null}]}

data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"add_todo","arguments":""}}]},"finish_reason":null}]}

data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"ti"}}]},"finish_reason":null}]}

data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

规则只有四条：
- 每个事件以 `data: ` 开头，事件间以空行分隔；
- `delta` 是**增量**：`content` 是新增文本；`tool_calls[].arguments` 是**字符串分片，必须按顺序拼接**；
- `tool_calls[].index` 标识是第几个调用（并行调用时靠它分组）；
- `data: [DONE]` 是结束哨兵。

**为什么不用浏览器的 `EventSource`**：它只支持 GET、不能带 `Authorization` 头、不能 POST body——所以必须 `fetch` + 手动读流。这是所有大模型客户端都自己写 SSE 解析的原因。

### 2.3 `tool_calls` 增量拼接（本项目最大坑点）

`arguments` 会被切成任意碎片（如 `{"ti` + `tle\":\"` + `牛奶\"}`），且 `id`/`name` 只在首个分片出现。拼接器按 `index` 分组、字符串累加：

```ts
type ToolCallAcc = { id: string; name: string; arguments: string };
const acc = new Map<number, ToolCallAcc>();

for (const tc of delta.tool_calls ?? []) {
  const cur = acc.get(tc.index) ?? { id: "", name: "", arguments: "" };
  if (tc.id) cur.id = tc.id;
  if (tc.function?.name) cur.name += tc.function.name;   // name 偶尔也分片
  if (tc.function?.arguments) cur.arguments += tc.function.arguments;
  acc.set(tc.index, cur);
}
// finish_reason === "tool_calls" 时，按 index 升序输出完整数组
```

## 3. 业界规范与常见做法

- **OpenAI 兼容是事实标准**：DeepSeek、Kimi(Moonshot)、硅基流动、GLM、Ollama 都实现了 `/chat/completions` 方言。差异集中在：baseURL、鉴权、模型名、个别不支持的功能（如部分推理模型不支持 function calling）。所以**抽象一个 Provider，用"预设表"承载差异**，而不是每家一个类。
- **参考系**：Vercel AI SDK / LangChain 的抽象都收敛在 `streamText({ messages, tools })` 这个形状——证明这层抽象是稳定的；我们自研（教学目的）但形状对齐它们。
- **错误分类要显式**：401（Key 错）/ 429（限流，可重试）/ 5xx（可重试）/ 400（参数错，不可重试）/ 网络错误（可重试）。重试用指数退避 + 抖动，并尊重 `Retry-After` 头与 `AbortSignal`。

## 4. 参考实现（v0.3.0 的实现规格）

### 4.1 类型（`src/agent/providers/types.ts`）

```ts
/** 四种角色的消息。判别联合，UI 与内核共享此类型。 */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string }; // content 恒为 JSON 字符串

export interface ToolCall { id: string; name: string; arguments: string } // arguments 原始 JSON 串

export interface ToolSpec {            // 发给模型的工具声明
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
}

/** 流式事件：UI 只消费 text-delta；循环消费 tool-calls 与 finish */
export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-calls"; calls: ToolCall[] }        // 组装完成后一次性发出
  | { type: "finish"; reason: "stop" | "tool_calls" | "length" }
  | { type: "error"; error: ProviderError };

export interface ProviderError { kind: "auth" | "rate-limit" | "server" | "bad-request" | "network" | "aborted"; message: string }

/** Provider 唯一接口：换提供商 = 换实现/配置 */
export interface LLMProvider {
  readonly id: string;
  chatStream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}
```

设计决定：**tool-calls 组装好后一次性发出**（而不是透传每个分片）——消费方（Agent 循环）只需要完整调用；文本才需要逐字增量。这砍掉一半的事件处理复杂度。

### 4.2 SSE 解析器（`sse.ts`，纯函数，可单测）

```ts
/** 把 fetch 的 Response 解析成 SSE data 载荷序列（Tauri WebView 与 Node 均可用） */
export async function* parseSSE(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });   // 多字节字符可能被切断，必须 stream 模式
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1); // 兼容 CRLF
        if (!line.startsWith("data:")) continue;           // 忽略空行/注释/event: 行
        const payload = line.slice(5).trimStart();
        if (payload === "[DONE]") return;                  // 结束哨兵
        yield payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
  // 注意：循环结束后 buf 里残留的不完整行按协议应丢弃（服务端保证事件完整才 flush）
}
```

### 4.3 OpenAI 兼容实现（`openai-compatible.ts`，核心骨架）

```ts
export interface OpenAICompatConfig { baseURL: string; apiKey?: string; model: string; }

export class OpenAICompatProvider implements LLMProvider {
  constructor(readonly id: string, private cfg: OpenAICompatConfig) {}

  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json",
                   ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
        body: JSON.stringify(this.toBody(req)),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) yield { type: "error", error: { kind: "aborted", message: "已停止" } };
      else yield { type: "error", error: { kind: "network", message: String(e) } };
      return;
    }
    if (!res.ok) { yield { type: "error", error: classifyHTTP(res) }; return; } // 401→auth 429→rate-limit …

    const acc = new Map<number, ToolCallAcc>();
    let reason: "stop" | "tool_calls" | "length" = "stop";
    for await (const payload of parseSSE(res)) {
      const chunk = JSON.parse(payload);                       // 生产实现需 try/catch 单包隔离
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const { delta, finish_reason } = choice;
      if (delta?.content) yield { type: "text-delta", text: delta.content };
      if (delta?.tool_calls) collectToolCallDeltas(acc, delta.tool_calls);
      if (finish_reason) reason = finish_reason;
    }
    if (acc.size > 0) {
      yield { type: "tool-calls", calls: [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) };
    }
    yield { type: "finish", reason };
  }

  private toBody(req: ChatRequest) {
    return {
      model: this.cfg.model,
      messages: req.messages.map(serializeMessage),   // assistant.toolCalls → tool_calls；tool → tool_call_id
      ...(req.tools?.length && { tools: req.tools.map(t => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters } })) }),
      ...(req.temperature != null && { temperature: req.temperature }),
      ...(req.maxTokens != null && { max_tokens: req.maxTokens }),
      stream: true,
    };
  }
}
```

`classifyHTTP`：读响应体 JSON 的 `error.message`，按状态码映射 `ProviderError.kind`（401→auth、429→rate-limit、400/422→bad-request、其余 5xx→server）。**Key 永远不出现在错误 message 里**（打日志前过滤）。

### 4.4 预设表（`presets.ts`）——差异都在数据里

```ts
export interface ProviderPreset {
  id: string; label: string;
  baseURL: string; defaultModel: string; models: string[];
  requiresKey: boolean; keysUrl?: string;     // 引导用户去哪申请
  notes?: string;                             // 如：reasoner 不支持 function calling
}
export const PRESETS: ProviderPreset[] = [
  { id: "deepseek", label: "DeepSeek", baseURL: "https://api.deepseek.com",
    defaultModel: "deepseek-chat", models: ["deepseek-chat", "deepseek-reasoner"],
    requiresKey: true, keysUrl: "https://platform.deepseek.com",
    notes: "工具调用请使用 deepseek-chat" },
  { id: "moonshot", label: "Kimi", baseURL: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k", models: ["moonshot-v1-8k", "moonshot-v1-32k", "kimi-k2-0711-preview"], requiresKey: true, keysUrl: "https://platform.moonshot.cn" },
  { id: "siliconflow", label: "硅基流动", baseURL: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3", models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"], requiresKey: true, keysUrl: "https://siliconflow.cn" },
  { id: "ollama", label: "Ollama（本地）", baseURL: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:7b", models: [], requiresKey: false,
    notes: "模型列表本机动态获取" },
];
```

模型名以各官方文档为准（预设表是唯一需要跟进更新的数据）。**新增提供商 = 加一行预设**，零代码改动——这就是抽象的收益。

### 4.5 MockProvider（`mock.ts`）——没有 Key 也能开发

```ts
/** 按脚本回放的假 Provider：UI 开发/测试/演示的依赖注入点 */
export class MockProvider implements LLMProvider {
  readonly id = "mock";
  private script: Array<(req: ChatRequest) => StreamEvent[] | Promise<StreamEvent[]>> = [];
  enqueue(responder: (req: ChatRequest) => StreamEvent[]) { this.script.push(responder); }
  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const events = this.script.length > 0 ? this.script.shift()!(req)
      : [{ type: "text-delta", text: "（Mock）" } as StreamEvent];
    for (const ev of events) { await sleep(30); yield ev; }   // 模拟网络延迟
    yield { type: "finish", reason: "stop" };
  }
}
```

v0.3.0 起所有 UI 联调先用 Mock 跑通，再切真实 Key——这习惯能省一半调试时间。

### 4.6 重试与超时策略（写在实现注释里的规范）

- 只重试 `rate-limit` 与 `server`、`network`；`auth`/`bad-request` 立即报给 UI；
- 指数退避：`delay = 500ms × 2^attempt + random(0, 250)`，最多 2 次重试；429 优先读 `Retry-After` 头；
- 每次重试前检查 `signal.aborted`；
- 无响应超时（连接 30s 无首字节）主动 abort，转 `network` 错误。

## 5. 设计取舍

| 决策 | 为什么 | 放弃了什么 |
|---|---|---|
| 自写 fetch 客户端而非 `openai` SDK | 教学（看穿协议）；零依赖；Tauri WebView 环境可控 | SDK 的自动重试/类型同步。形状已对齐，未来可无缝替换 |
| tool-calls 组装后一次发出 | 循环消费方要的是完整调用 | 无法在 UI 展示"工具参数流入中"的动效（v1 不做） |
| `AsyncIterable<StreamEvent>` 而非回调 | `for await` 天然背压、可 `break` 中断、可组合 | 回调写法更直白但难清理 |
| 预设表承载提供商差异 | 差异是数据不是逻辑 | 无法承载真正的协议差异（如 Anthropic 原生 API）——需要时再实现第二个 Provider 类 |
| MockProvider 进主干代码 | UI 全流程可开发可测试 | 无 |

## 6. 复盘自测（合上文档默写）

1. 默写 Chat Completions 请求体的五个顶层字段与四种 `role`；工具结果消息有哪两个字段？
2. SSE 的四条解析规则；为什么不能用 `EventSource`？
3. `tool_calls` 增量拼接：`index`/`id`/`arguments` 各自的处理规则？何时 emit？
4. `finish_reason` 三种取值的含义；循环层看到 `tool_calls` 后该做什么（可只答方向）？
5. 哪些错误可重试、哪些不可？退避公式？
6. 新增一个"DeepSeek 官方换价格更低的镜像站"，代码要改几处？（答案：预设表 1 处）
7. MockProvider 存在的工程价值是什么？

## 7. 延伸阅读

- OpenAI Chat Completions API 参考（协议事实标准）：https://platform.openai.com/docs/api-reference/chat
- DeepSeek 首次调用指南（中文，最接近本项目）：https://api-docs.deepseek.com/zh-cn/
- MDN：Streams API 与 TextDecoder stream 模式：https://developer.mozilla.org/docs/Web/API/Streams_API
- Vercel AI SDK 源码（看它的 provider 抽象，与本节对照）
