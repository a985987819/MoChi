/**
 * AgentFacade —— Agent 内核与 UI 的接缝（learning/01 §4.4）。
 *
 * 职责：
 * 1. 组装依赖：provider（按设置）+ registry（全部工具）+ services（todos/pet）；
 * 2. 组装消息：[system, ...历史, user(当前输入)]（v0.4.0 历史=UI 纯文本轮次；
 *    v0.5.0 起换成 SQLite 协议历史 + 记忆检索注入，context-builder 接口已预留）；
 * 3. 驱动宠物状态：thinking（回合开始/step-end 续期）→ talking（每个增量续期）→
 *    自然到期回落 idle（learning/08 §2：thinking/talking 由应用从 AgentEvent 映射，
 *    模型不自导自演）；
 * 4. 暴露 runTurn 给 ChatTab，UI 只消费 AgentEvent。
 */

import { createProvider } from "@/agent/providers";
import type { ChatMessage } from "@/agent/providers/types";
import { runAgent, type AgentEvent } from "@/agent/core/agent";
import { SYSTEM_PROMPT } from "@/agent/core/prompt";
import { ToolRegistry, type AppServices } from "@/agent/tools/registry";
import { addTodoTool, completeTodoTool, deleteTodoTool, listTodosTool } from "@/agent/tools/todo";
import { setPetStateTool } from "@/agent/tools/pet-state";
import { todoService } from "@/services/todos";
import { loadSettings } from "@/services/settings";
import { sendStateEvent, STATE_EVENTS } from "@/shared/events";

/** thinking 状态的单次续期时长（工具执行可能超 10s，给足量级；step-end 续期） */
const THINKING_SECONDS = 60;
/** talking 每个增量续期时长：停止输出后很快回落（软萌性格不拖泥带水） */
const TALKING_SECONDS = 12;

export class AgentFacade {
  private registry = new ToolRegistry();
  private services: AppServices;

  constructor() {
    // 宠物控制 = 跨窗口事件（宠物窗 PetStateManager 是宿主，v0.2.0 已装监听）
    this.services = {
      todos: todoService,
      pet: {
        setMood: (state, durationSec) => {
          void sendStateEvent(STATE_EVENTS.setMood, { state, durationSec });
        },
      },
    };

    // v0.4.0 工具清单（learning/01 §4.5；v0.6.0 + food-search、v0.7.0 + pomodoro/reminder 系列）
    this.registry.register(addTodoTool());
    this.registry.register(listTodosTool());
    this.registry.register(completeTodoTool());
    this.registry.register(deleteTodoTool());
    this.registry.register(setPetStateTool());
  }

  /** UI 展示"麻薯会什么"（可选功能，暂留调试价值） */
  listTools() {
    return this.registry.list();
  }

  /** 一轮对话：从用户输入到终答的完整 Agent 循环 */
  async *runTurn(opts: {
    /** UI 历史轮次（纯 user/assistant 文本；v0.5.0 起换协议历史） */
    history: ChatMessage[];
    userInput: string;
    signal: AbortSignal;
  }): AsyncGenerator<AgentEvent> {
    const settings = await loadSettings();
    const provider = createProvider(settings);

    this.services.pet.setMood("thinking", THINKING_SECONDS);

    // v0.4.0 组装：system + 历史轮次 + 当前输入。
    // v0.5.0 起改为 buildInitialMessages（+ 记忆检索注入）+ SQLite 协议历史——接口已备
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...opts.history,
      { role: "user", content: opts.userInput },
    ];

    try {
      for await (const ev of runAgent({
        provider,
        messages,
        registry: this.registry,
        ctx: { signal: opts.signal, services: this.services },
        signal: opts.signal,
      })) {
        if (ev.type === "text-delta") {
          // 首个增量即切换 talking 并持续续期；停止输出后 12s 自然回落
          this.services.pet.setMood("talking", TALKING_SECONDS);
        } else if (ev.type === "step-end") {
          // 还有下一轮 LLM 调用：续期 thinking（工具执行可能耗时不短）
          this.services.pet.setMood("thinking", THINKING_SECONDS);
        }
        yield ev;
      }
    } catch (e) {
      // 传输层致命错误（auth/network…）：向上抛给 ChatTab 的错误条
      throw e;
    }
  }
}

/** 聊天窗单例 */
export const agentFacade = new AgentFacade();
