/**
 * OpenAI 兼容 Provider —— 规格：docs/learning/02-provider-abstraction.md §4.3~§4.6。
 *
 * 一个实现通吃 DeepSeek/Kimi/硅基流动/Ollama 等（差异进 presets.ts 的数据，不进代码）。
 * 关键机制：
 * - SSE 流式 + tool_calls 增量拼接（按 index 分组、arguments 字符串累加，02 §2.3）；
 * - HTTP 状态分类（classifyHTTP）；连接阶段重试（指数退避 + 抖动，仅可重试类错误）；
 * - AbortSignal 全程贯穿（停止按钮/超时）；
 * - 错误 message 永不含 API Key。
 */

import { parseSSE } from "./sse";
import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  ProviderError,
  ProviderErrorKind,
  StreamEvent,
  ToolCall,
} from "./types";

export interface OpenAICompatConfig {
  baseURL: string; // 形如 https://api.deepseek.com（无尾斜杠）
  apiKey?: string; // Ollama 等本地服务可空
  model: string;
}

const CONNECT_TIMEOUT_MS = 30_000; // 首字节超时：无响应 30s 判网络错误
const CONNECT_RETRIES = 2;

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

/** tool_calls 增量拼接（02 §2.3）：按 index 分组；id/name 首个分片到达；arguments 顺序累加 */
function collectToolCallDeltas(acc: Map<number, ToolCallAcc>, deltas: RawToolCallDelta[]): void {
  for (const tc of deltas) {
    const cur = acc.get(tc.index) ?? { id: "", name: "", arguments: "" };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name += tc.function.name; // name 偶尔也分片
    if (tc.function?.arguments) cur.arguments += tc.function.arguments;
    acc.set(tc.index, cur);
  }
}

interface RawToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** HTTP 状态 → ProviderError（读 body 的 error.message 作为细节；永不回传 Key） */
async function classifyHTTP(res: Response): Promise<ProviderError> {
  const kind: ProviderErrorKind =
    res.status === 401 || res.status === 403
      ? "auth"
      : res.status === 429
        ? "rate-limit"
        : res.status < 500
          ? "bad-request"
          : "server";
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) detail = body.error.message;
  } catch {
    // body 非 JSON：保留状态码信息
  }
  return { kind, message: detail };
}

const retryable = (e: ProviderError): boolean =>
  e.kind === "rate-limit" || e.kind === "server" || e.kind === "network";

/** 02 §4.6：指数退避 + 抖动（Retry-After 头的精读留 v0.4 连同 Agent 重试策略一起做） */
const backoffDelay = (attempt: number): number => 500 * 2 ** attempt + Math.random() * 250;

export class OpenAICompatProvider implements LLMProvider {
  constructor(
    readonly id: string,
    private cfg: OpenAICompatConfig,
  ) {}

  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    // ── 连接阶段（可重试）：只在拿到响应头前重试，流一旦开始绝不重试 ──
    let res: Response | null = null;
    let lastError: ProviderError | null = null;
    for (let attempt = 0; attempt <= CONNECT_RETRIES; attempt++) {
      if (signal?.aborted) {
        yield { type: "error", error: { kind: "aborted", message: "已停止" } };
        return;
      }
      const timeout = new AbortController();
      const timer = window.setTimeout(() => timeout.abort(), CONNECT_TIMEOUT_MS);
      const linked = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      try {
        const resAttempt = await fetch(`${this.cfg.baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
          },
          body: JSON.stringify(this.toBody(req)),
          signal: linked,
        });
        if (!resAttempt.ok) {
          lastError = await classifyHTTP(resAttempt);
          if (!retryable(lastError)) {
            yield { type: "error", error: lastError };
            return;
          }
        } else {
          res = resAttempt;
          break;
        }
      } catch (e) {
        if (signal?.aborted) {
          yield { type: "error", error: { kind: "aborted", message: "已停止" } };
          return;
        }
        lastError = { kind: "network", message: String(e) };
      } finally {
        window.clearTimeout(timer);
      }
      if (attempt < CONNECT_RETRIES) {
        await new Promise(r => window.setTimeout(r, backoffDelay(attempt)));
      }
    }
    if (!res) {
      yield { type: "error", error: lastError ?? { kind: "network", message: "连接失败" } };
      return;
    }

    // ── 流阶段（不可重试）：解析 SSE，拼接增量 ──
    const acc = new Map<number, ToolCallAcc>();
    let reason: "stop" | "tool_calls" | "length" = "stop";
    try {
      for await (const payload of parseSSE(res)) {
        let chunk: {
          choices?: Array<{
            delta?: { content?: string; tool_calls?: RawToolCallDelta[] };
            finish_reason?: "stop" | "tool_calls" | "length";
          }>;
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // 单包损坏跳过，不炸整条流（生产实现可计数上报）
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) yield { type: "text-delta", text: choice.delta.content };
        if (choice.delta?.tool_calls) collectToolCallDeltas(acc, choice.delta.tool_calls);
        if (choice.finish_reason) reason = choice.finish_reason;
      }
    } catch (e) {
      if (signal?.aborted) {
        yield { type: "error", error: { kind: "aborted", message: "已停止" } };
        return;
      }
      yield { type: "error", error: { kind: "network", message: `流中断: ${String(e)}` } };
      return;
    }
    if (acc.size > 0) {
      const calls: ToolCall[] = [...acc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v);
      yield { type: "tool-calls", calls };
    }
    yield { type: "finish", reason };
  }

  /** 消息序列 → 请求体（assistant.toolCalls → tool_calls；tool → tool_call_id） */
  private toBody(req: ChatRequest) {
    return {
      model: this.cfg.model,
      messages: req.messages.map(serializeMessage),
      ...(req.tools?.length && {
        tools: req.tools.map(t => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
      ...(req.temperature != null && { temperature: req.temperature }),
      ...(req.maxTokens != null && { max_tokens: req.maxTokens }),
      stream: true,
    };
  }
}

/** ChatMessage → 协议线格式（v0.4.0 的工具消息也在此就位） */
function serializeMessage(m: ChatMessage): unknown {
  switch (m.role) {
    case "assistant":
      return {
        role: "assistant",
        ...(m.content != null ? { content: m.content } : {}),
        ...(m.toolCalls?.length && {
          tool_calls: m.toolCalls.map(c => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          })),
        }),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}
