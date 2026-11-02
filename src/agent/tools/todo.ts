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
}
interface IdArgs {
  id: number;
}

export function addTodoTool(): ToolDefinition<TitleArgs> {
  return {
    name: "add_todo",
    description:
      "添加一条待办。用于用户明确要记录的任务（'帮我加个待办'/'记一下…'）。" +
      "如果用户意图是'到某个时间点提醒我'，本工具不适用（提醒功能未上线，请如实说明）。" +
      "due 传用户原话（如'明天九点'），不要自行换算成具体日期时间。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "待办标题，简洁完整，如：开周会" },
        due: { type: "string", description: "截止时间，可选。传用户原话，不做解析" },
      },
      required: ["title"],
    },
    risk: "write",
    async execute(args: TitleArgs, ctx: ToolContext) {
      const todo = ctx.services.todos.add(args.title, args.due);
      return ok({ id: todo.id, title: todo.title, due: todo.due, message: "已添加" });
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
