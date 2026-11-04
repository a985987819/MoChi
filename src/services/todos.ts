/**
 * TodoService —— v0.5.0：后端从 plugin-store 迁移到 SQLite（todos 表，learning/04 §3.1）。
 *
 * **对外接口与 v0.4.0 完全一致**（add/list/complete/remove/subscribe）——
 * TodoTab 与 todo_* 工具（learning/07 双入口的两个入口）零改动，后端无感切换。
 * 迁移路径：首启发现 todos.json 有数据 → 整批插入 SQLite → 清空旧文件。
 */

import { load } from "@tauri-apps/plugin-store";
import { getDb } from "./db";

export interface Todo {
  id: number;
  title: string;
  /** 用户原话或 ISO 日期（v1 不做自然语言时间解析——learning/01 §4.5） */
  due?: string;
  done: boolean;
  createdAt: number;
  doneAt?: number;
}

interface TodoRow {
  id: number;
  title: string;
  due: string | null;
  done: number;
  created_at: number;
  done_at: number | null;
}

const LEGACY_STORE_FILE = "todos.json";

export class TodoService {
  private todos: Todo[] = [];
  private listeners = new Set<() => void>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const db = await getDb();

    // ── 旧数据迁移：todos.json → SQLite（一次性，迁移后清空旧文件内容）──
    try {
      const legacy = await load(LEGACY_STORE_FILE, { autoSave: true });
      const saved = await legacy.get<Todo[]>("todos");
      if (Array.isArray(saved) && saved.length > 0) {
        for (const t of saved) {
          await db.execute(
            "INSERT OR IGNORE INTO todos (id, title, due, done, created_at, done_at) VALUES ($1,$2,$3,$4,$5,$6)",
            [t.id, t.title, t.due ?? null, t.done ? 1 : 0, t.createdAt, t.doneAt ?? null],
          );
        }
        await legacy.set("todos", []); // 清内容保文件（store 无法删除文件本身）
      }
    } catch {
      // 无旧数据/读取失败：正常路径
    }

    const rows = await db.select<TodoRow[]>("SELECT id, title, due, done, created_at, done_at FROM todos ORDER BY id");
    this.todos = rows.map(rowToTodo);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): Todo[] {
    return [...this.todos];
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** add_todo 工具与 UI 新增共用入口 */
  async add(title: string, due?: string): Promise<Todo> {
    const db = await getDb();
    const createdAt = Date.now();
    const result = await db.execute("INSERT INTO todos (title, due, done, created_at) VALUES ($1,$2,0,$3)", [
      title.trim(),
      due?.trim() || null,
      createdAt,
    ]);
    const todo: Todo = {
      id: result.lastInsertId as number,
      title: title.trim(),
      ...(due?.trim() ? { due: due.trim() } : {}),
      done: false,
      createdAt,
    };
    this.todos.push(todo);
    this.notify();
    return todo;
  }

  list(includeDone = false): Todo[] {
    return includeDone ? this.snapshot() : this.snapshot().filter(t => !t.done);
  }

  async complete(id: number): Promise<Todo | null> {
    const todo = this.todos.find(t => t.id === id && !t.done);
    if (!todo) return null;
    const db = await getDb();
    const doneAt = Date.now();
    // 先落库再改内存：写入失败时 UI/Agent 仍应读到未完成状态。
    await db.execute("UPDATE todos SET done = 1, done_at = $1 WHERE id = $2", [doneAt, id]);
    todo.done = true;
    todo.doneAt = doneAt;
    this.notify();
    return todo;
  }

  /** 删除返回被删条目——learning/07 §6.3：destructive 类工具必须有可追溯输出 */
  async remove(id: number): Promise<Todo | null> {
    const idx = this.todos.findIndex(t => t.id === id);
    if (idx < 0) return null;
    const db = await getDb();
    const removed = this.todos[idx];
    await db.execute("DELETE FROM todos WHERE id = $1", [id]);
    // 按 id 移除而不复用 await 前的下标，防止两个删除并发时删错另一条。
    this.todos = this.todos.filter(t => t.id !== id);
    this.notify();
    return removed;
  }
}

function rowToTodo(r: TodoRow): Todo {
  return {
    id: r.id,
    title: r.title,
    ...(r.due ? { due: r.due } : {}),
    done: r.done === 1,
    createdAt: r.created_at,
    ...(r.done_at != null ? { doneAt: r.done_at } : {}),
  };
}

/** 聊天窗单例（工具与 TodosTab 共用） */
export const todoService = new TodoService();
