/**
 * ToolRegistry —— 工具的注册表与统一执行入口。
 * 规格：docs/learning/01-agent-loop.md §4.1；风险分级规范：learning/07 §4.3。
 *
 * 三条铁律（01 §2.2/§3）：
 * 1. 工具执行 = 应用 Service 的薄封装——工具函数里**不写业务逻辑**（07 铁律 2）；
 * 2. 一切失败转为 `{ok:false,error}` 回传模型自愈，绝不上抛炸循环（幻觉工具名/
 *    非法 JSON/执行异常都走这条路）；
 * 3. 工具结果统一 JSON 字符串（role:"tool".content 协议要求）。
 */

import type { ToolSpec } from "@/agent/providers/types";
import type { PetState } from "@/services/pet-state";
import type { TodoService } from "@/services/todos";
import type { MemoryService } from "@/agent/memory/long-term";
import type { FoodIndexService } from "@/rag/food";
import { validateSchema } from "./validate-schema";

/** 工具依赖注入的出口：Agent 内核不 import 任何具体业务模块（AGENTS.md 目录职责） */
export interface AppServices {
  todos: TodoService;
  memory: MemoryService;
  food: FoodIndexService;
  /** 宠物情绪控制（跨窗口：经 state://set-mood 事件到宠物窗的 PetStateManager） */
  pet: { setMood(state: PetState, durationSec?: number): void };
}

export interface ToolContext {
  signal: AbortSignal;
  services: AppServices;
}

export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: string };

/** 工具风险分级（learning/07 §4.3）：新工具登记时必须标注 */
export type ToolRisk = "read" | "write" | "destructive";

export interface ToolDefinition<A = Record<string, unknown>> {
  name: string;
  /** 写给模型：何时用 + 参数语义。工具质量的第一决定因素（01 §3） */
  description: string;
  /** 写给模型：参数协议（JSON Schema 子集） */
  parameters: ToolSpec["parameters"];
  /** 07 §6.3 自查：read / write / destructive（destructive 需可追溯输出） */
  risk: ToolRisk;
  execute(args: A, ctx: ToolContext): Promise<ToolOutcome>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register<A>(tool: ToolDefinition<A>): void {
    if (this.tools.has(tool.name)) throw new Error(`工具重名: ${tool.name}`);
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
  }

  /** 发给模型的声明列表（OpenAI tools 数组的 Mochi 形状） */
  toSpecs(): ToolSpec[] {
    return [...this.tools.values()].map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /** 调试/展示用（待办 Tab 的"麻薯会什么"提示可复用） */
  list(): Array<{ name: string; description: string; risk: ToolRisk }> {
    return [...this.tools.values()].map(t => ({ name: t.name, description: t.description, risk: t.risk }));
  }

  /**
   * 统一执行入口：查表 → JSON 解析 → Schema 校验 → 执行 → 序列化。
   * 任何失败都不抛出，转为 ok:false 结果交给模型（01 §2.2 自愈机制）。
   */
  async execute(name: string, argsJson: string, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `未知工具: ${name}。可用工具: ${[...this.tools.keys()].join(", ")}` };

    let args: unknown;
    try {
      args = JSON.parse(argsJson || "{}");
    } catch {
      return { ok: false, error: "参数不是合法 JSON，请重新输出完整参数" };
    }
    const invalid = validateSchema(tool.parameters, args);
    if (invalid) return { ok: false, error: `参数校验失败: ${invalid}` };

    try {
      return await tool.execute(args as never, ctx);
    } catch (e) {
      return { ok: false, error: `执行异常: ${String(e)}` };
    }
  }
}
