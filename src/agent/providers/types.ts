/**
 * Provider 层类型定义 —— 规格：docs/learning/02-provider-abstraction.md §4.1。
 *
 * 心智模型（02 §2.1）：模型是无状态函数 f(messages) → message；
 * 工具调用 = 模型输出"我想调 X"的结构化请求，执行方是我们的代码。
 * 本层只负责把字节流变成这些类型，不含任何业务。
 */

/** 迷你 JSON Schema 类型（工具参数协议用；v0.4.0 的校验器也基于它） */
export interface JsonSchemaObject {
  type: "object" | "string" | "number" | "boolean" | "array";
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  enum?: string[];
  items?: JsonSchemaObject;
  description?: string;
}

export interface ToolCall {
  /** 本次调用的唯一 ID——回填工具结果时用 role:"tool" + toolCallId 对号入座 */
  id: string;
  name: string;
  /** 协议规定是 JSON **字符串**（不是对象！），且可能是残缺/非法 JSON——调用方必须 try/catch */
  arguments: string;
}

/** 四种角色的消息（判别联合）。与 OpenAI 兼容协议一一对应 */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** 发给模型的工具声明（v0.4.0 ToolRegistry 产出） */
export interface ToolSpec {
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

export type ProviderErrorKind =
  | "auth" // 401：Key 无效 → 不可重试，提示用户
  | "rate-limit" // 429：限流 → 可重试
  | "server" // 5xx → 可重试
  | "bad-request" // 400/422：参数/协议错误 → 不可重试（通常是我们的 bug）
  | "network" // 连接失败/超时 → 可重试
  | "aborted"; // 用户主动停止

export interface ProviderError {
  kind: ProviderErrorKind;
  message: string; // 永远不得包含 API Key（02 §4.3）
}

/**
 * 流式事件。设计决定（02 §4.1）：tool-calls 组装完成后**一次性**发出——
 * 循环消费方要的是完整调用；文本才需要逐字增量。砍掉一半的事件处理复杂度。
 */
export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-calls"; calls: ToolCall[] }
  | { type: "finish"; reason: "stop" | "tool_calls" | "length" }
  | { type: "error"; error: ProviderError };

/** Provider 唯一接口：换提供商 = 换实现/配置，不是换代码（02 §2.3） */
export interface LLMProvider {
  readonly id: string;
  chatStream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}
