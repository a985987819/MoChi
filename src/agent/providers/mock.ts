/**
 * MockProvider —— 规格：docs/learning/02-provider-abstraction.md §4.5。
 *
 * 价值：无 Key/离线也能开发与验收全部 UI 流程（聊天/设置/停止按钮/错误态）；
 * v0.4.0 起 ToolRegistry 的联调也先走 Mock（脚本化 tool-calls 事件）。
 * 进主干而非 test-only：演示模式对用户同样有价值。
 */

import type { ChatRequest, LLMProvider, StreamEvent } from "./types";

const sleep = (ms: number): Promise<void> => new Promise(r => window.setTimeout(r, ms));

export class MockProvider implements LLMProvider {
  readonly id = "mock";

  /** 脚本队列：测试/演示可注入确定性回复；空队列走默认回声 */
  private script: Array<(req: ChatRequest) => StreamEvent[]> = [];

  enqueue(responder: (req: ChatRequest) => StreamEvent[]): void {
    this.script.push(responder);
  }

  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const lastUser = [...req.messages].reverse().find(m => m.role === "user");
    const events =
      this.script.length > 0
        ? this.script.shift()!(req)
        : this.echoResponse(typeof lastUser?.content === "string" ? lastUser.content : "");

    for (const ev of events) {
      if (signal?.aborted) {
        yield { type: "error", error: { kind: "aborted", message: "已停止" } };
        return;
      }
      await sleep(24); // 模拟网络节奏，让流式 UI 的光标/增量可见
      yield ev;
    }
  }

  /** 默认行为：分片回声（验证流式拼接与渲染） */
  private echoResponse(userText: string): StreamEvent[] {
    const text = `（Mock）你说：「${userText}」。配置真实 Key 后我就接上 DeepSeek 啦～`;
    const chunks = text.match(/.{1,6}/gs) ?? [];
    return chunks.map(text => ({ type: "text-delta", text }) as StreamEvent);
  }
}
