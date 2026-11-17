/**
 * todo_* 工具 —— 规格：docs/learning/01-agent-loop.md §4.5。
 *
 * 全部是对 TodoService 的薄封装（learning/07 铁律 2：工具不写业务逻辑，Service 是双入口的汇合点）。
 * `due` 允许模型直接传用户原话（"明天九点"），UI 展示原文——v1 不做时间解析，
 * 防幻觉具体时刻（到点提醒归 v0.7.0 的 create_reminder，见 learning/08 §5）。
 * delete_todo 是 destructive 级（learning/07 §4.3）：返回被删条目内容保证可追溯。
 */

import type { ToolContext, ToolDefinition } from "./registry";
import type { Todo } from "@/services/todos";

const ok = (data: unknown) => ({ ok: true as const, data });

interface TitleArgs {
  title: string;
  due?: string;
  due_at?: string;
}
interface IdArgs {
  id: number;
}

/**
 * 解析待办的到期时刻（v0.13.0）。
 *
 * 与 `create_reminder` 的 `parseFireAt` 有一处**刻意不同**：这里允许过去时间。
 * "已经逾期但还没做"是待办要如实呈现的状态（清单上一眼看到红色"昨天到期"），
 * 拒绝它只会让模型把逾期任务硬塞成未来时间，信息反而失真。
 */
export function parseDueAt(input: string): { ms: number } | { error: string } {
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) {
    return { error: `无法解析时间"${input}"，请改用 ISO 8601（如 2026-11-04T09:00:00+08:00）` };
  }
  return { ms };
}

export function addTodoTool(): ToolDefinition<TitleArgs> {
  return {
    name: "add_todo",
    description:
      "添加一条待办。用于用户明确要记录的任务（'帮我加个待办'/'记一下…'）。" +
      "如果用户意图是'到某个时间点提醒我'，请改用 create_reminder（到点弹通知）。" +
      "due 传用户原话（如'明天九点'），**不解析**，只用于展示；" +
      "due_at（v0.13.0）传 ISO 8601 绝对时间时，该待办到期会**自动弹一次提醒**——" +
      "用户既想要'记在清单里'又想要'到点叫我'时用它。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "待办标题，简洁完整，如：开周会" },
        due: { type: "string", description: "截止时间，可选。传用户原话，不做解析" },
        due_at: {
          type: "string",
          description: "结构化到期时间 ISO 8601（可选）。给它就等于给这条待办挂了一个到点提醒",
        },
      },
      required: ["title"],
    },
    risk: "write",
    async execute(args: TitleArgs, ctx: ToolContext) {
      let dueAtMs: number | undefined;
      if (typeof args.due_at === "string" && args.due_at.trim()) {
        const parsed = parseDueAt(args.due_at);
        if ("error" in parsed) return { ok: false as const, error: parsed.error };
        dueAtMs = parsed.ms;
      }
      const todo = await ctx.services.todos.add(args.title, args.due, dueAtMs);
      return ok({
        id: todo.id,
        title: todo.title,
        due: todo.due,
        due_at_local: todo.dueAt ? new Date(todo.dueAt).toLocaleString("zh-CN") : undefined,
        message: dueAtMs ? "已添加，到点会提醒你" : "已添加",
      });
    },
  };
}

export function listTodosTool(): ToolDefinition<{ includeDone?: boolean }> {
  return {
    name: "list_todos",
    description: "列出用户的待办。用户问'我有什么待办/待办都有啥'时使用。默认只返回未完成的。",
    parameters: {
      type: "object",
      properties: {
        includeDone: { type: "boolean", description: "是否包含已完成项，默认 false" },
      },
    },
    risk: "read",
    async execute(args: { includeDone?: boolean }, ctx: ToolContext) {
      const todos: Todo[] = ctx.services.todos.list(args.includeDone ?? false);
      return ok({
        count: todos.length,
        todos: todos.map(t => ({ id: t.id, title: t.title, due: t.due, done: t.done })),
      });
    },
  };
}

export function completeTodoTool(): ToolDefinition<IdArgs> {
  return {
    name: "complete_todo",
    description: "把一条待办标记为完成。用户说'完成了/做完了某某'时使用。id 来自 list_todos 的结果；如果不知道 id，先调用 list_todos。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "待办 id（来自 list_todos）" },
      },
      required: ["id"],
    },
    risk: "write",
    async execute(args: IdArgs, ctx: ToolContext) {
      const todo = await ctx.services.todos.complete(args.id);
      if (!todo) return { ok: false as const, error: `找不到未完成的待办 id=${args.id}，可先用 list_todos 查询` };
      return ok({ id: todo.id, title: todo.title, message: "已完成" });
    },
  };
}

export function deleteTodoTool(): ToolDefinition<IdArgs> {
  return {
    name: "delete_todo",
    description: "删除一条待办（不是标记完成！用户明确说'删掉'时才用）。id 来自 list_todos；不确定时先查询并向用户确认删哪条。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "待办 id（来自 list_todos）" },
      },
      required: ["id"],
    },
    risk: "destructive",
    async execute(args: IdArgs, ctx: ToolContext) {
      const removed = await ctx.services.todos.remove(args.id);
      if (!removed) return { ok: false as const, error: `找不到待办 id=${args.id}，可先用 list_todos 查询` };
      // 可追溯输出（07 §6.3）：把被删内容原样告诉模型，便于向用户交代
      return ok({ deleted: { id: removed.id, title: removed.title }, message: "已删除" });
    },
  };
}
