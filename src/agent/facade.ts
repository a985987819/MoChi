/**
 * AgentFacade —— Agent 内核与 UI 的接缝（learning/01 §4.4）。
 *
 * v0.5.0 变化：
 * 1. **协议历史**：历史从 UI 文本轮次换成 HistoryStore（SQLite 协议原样），
 *    经 trimWindow 裁剪（03 §4.2）后进入上下文——重开窗口/重启后记忆仍在；
 * 2. **记忆检索注入**：每轮用当前输入检索长期记忆 top-3 注入（03 §2.1 第②层）；
 * 3. **持久化**：runAgent 的 persist 回调 → HistoryStore（协议原样逐条落库）。
 * 宠物 thinking/talking 映射维持 v0.4.0 行为。
 */

import { createProvider } from "@/agent/providers";
import { runAgent, type AgentEvent } from "@/agent/core/agent";
import { buildMessages } from "@/agent/core/context-builder";
import { HISTORY_BUDGET_TOKENS, trimWindow } from "@/agent/core/window";
import { ToolRegistry, type AppServices } from "@/agent/tools/registry";
import { addTodoTool, completeTodoTool, deleteTodoTool, listTodosTool } from "@/agent/tools/todo";
import { setPetStateTool } from "@/agent/tools/pet-state";
import { rememberTool } from "@/agent/tools/remember";
import { historyStore } from "@/agent/memory/history-store";
import { memoryService } from "@/agent/memory/long-term";
import { todoService } from "@/services/todos";
import { loadSettings } from "@/services/settings";
import { sendStateEvent, STATE_EVENTS } from "@/shared/events";

/** thinking 状态的单次续期时长（工具执行可能超 10s，给足量级；step-end 续期） */
const THINKING_SECONDS = 60;
/** talking 每个增量续期时长：停止输出后很快回落（软萌性格不拖泥带水） */
const TALKING_SECONDS = 12;
/** 长期记忆注入条数（03 §2.1 第②层预算 ~400tok） */
const MEMORY_TOP_K = 3;

export class AgentFacade {
  private registry = new ToolRegistry();
  private services: AppServices;

  constructor() {
    // 宠物控制 = 跨窗口事件（宠物窗 PetStateManager 是宿主，v0.2.0 已装监听）
    this.services = {
      todos: todoService,
      memory: memoryService,
      pet: {
        setMood: (state, durationSec) => {
          void sendStateEvent(STATE_EVENTS.setMood, { state, durationSec });
        },
      },
    };

    // 工具清单：v0.4.0（todo/pet-state）+ v0.5.0（remember）；
    // v0.6.0 + food-search、v0.7.0 + pomodoro/reminder 系列
    this.registry.register(addTodoTool());
    this.registry.register(listTodosTool());
    this.registry.register(completeTodoTool());
    this.registry.register(deleteTodoTool());
    this.registry.register(setPetStateTool());
    this.registry.register(rememberTool());
  }

  /** UI 展示"麻薯会什么"（调试价值） */
  listTools() {
    return this.registry.list();
  }

  /** 一轮对话：从用户输入到终答的完整 Agent 循环（历史/记忆/持久化都在内部闭环） */
  async *runTurn(opts: { userInput: string; signal: AbortSignal }): AsyncGenerator<AgentEvent> {
    const settings = await loadSettings();
    const provider = createProvider(settings);

    // ① 记忆检索（与当前输入最相关的长期事实）+ ② 历史窗口裁剪——并行取
    const [trimmedHistory, memories] = await Promise.all([
      historyStore.loadRecent().then(msgs => trimWindow(msgs, HISTORY_BUDGET_TOKENS)),
      memoryService.searchForContext(opts.userInput, MEMORY_TOP_K),
    ]);

    // ③ 五层上下文组装（03 §2.1）：system → 记忆 → 历史 → 当前输入
    const messages = buildMessages({ history: trimmedHistory, userInput: opts.userInput, memories });

    this.services.pet.setMood("thinking", THINKING_SECONDS);

    try {
      for await (const ev of runAgent({
        provider,
        messages,
        registry: this.registry,
        ctx: { signal: opts.signal, services: this.services },
        signal: opts.signal,
        // ④ 情景记忆：协议原样逐条落库（重启可恢复，learning/04 §4.3）
        persist: message => void historyStore.append([message]),
      })) {
        if (ev.type === "text-delta") {
          this.services.pet.setMood("talking", TALKING_SECONDS);
        } else if (ev.type === "step-end") {
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
