/**
 * TodoService —— v0.4.0：内存 + plugin-store 持久化（roadmap：先 Store，v0.5.0 迁 SQLite）。
 *
 * 这是 **Agent 工具与 UI 的共同底座**（learning/07 §3 双入口模式）：
 * ChatTab 的待办 Tab 与 todo_* 工具都汇入本服务，状态只有一个权威来源。
 * 变更通过 subscribe 通知本窗口订阅者（TodosTab）；跨窗口无需广播（待办只在聊天窗展示）。
 */

import { load } from "@tauri-apps/plugin-store";

export interface Todo {
  id: number;
  title: string;
  /** 用户原话或 ISO 日期（v1 明确不做自然语言时间解析，防幻觉具体时刻——learning/01 §4.5） */
  due?: string;
  done: boolean;
  createdAt: number;
  doneAt?: number;
}

const STORE_FILE = "todos.json";
const KEY = "todos";

export class TodoService {
  private todos: Todo[] = [];
  private listeners = new Set<() => void>();
  private readyPromise: Promise<void>;

  constructor() {
    this.readyPromise = this.init();
  }

  /** 启动加载（幂等，构造即调用） */
  private async init(): Promise<void> {
    try {
      const store = await load(STORE_FILE, { autoSave: true });
      const saved = await store.get<Todo[]>(KEY);
      if (Array.isArray(saved)) this.todos = saved;
    } catch {
      // 读取失败按空清单处理：待办不是关键数据，不阻塞应用
    }
  }

  /** TodosTab 等 ready 后再取首屏 */
  get ready(): Promise<void> {
    return this.readyPromise;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): Todo[] {
    return [...this.todos];
  }

  private async persist(): Promise<void> {
    try {
      const store = await load(STORE_FILE, { autoSave: true });
      await store.set(KEY, this.todos);
    } catch {
      // 持久化失败不炸内存态；下次变更会再试
    }
    for (const fn of this.listeners) fn();
  }

  /** add_todo 工具与 UI 新增共用入口 */
  add(title: string, due?: string): Todo {
    const todo: Todo = {
      id: (this.todos.length ? Math.max(...this.todos.map(t => t.id)) : 0) + 1,
      title: title.trim(),
      ...(due?.trim() ? { due: due.trim() } : {}),
      done: false,
      createdAt: Date.now(),
    };
    this.todos.push(todo);
    void this.persist();
    return todo;
  }

  list(includeDone = false): Todo[] {
    return includeDone ? this.snapshot() : this.snapshot().filter(t => !t.done);
  }

  async complete(id: number): Promise<Todo | null> {
    const todo = this.todos.find(t => t.id === id && !t.done);
    if (!todo) return null;
    todo.done = true;
    todo.doneAt = Date.now();
    await this.persist();
    return todo;
  }

  /** 删除返回被删条目——learning/07 §6.3：destructive 类工具必须有可追溯输出 */
  async remove(id: number): Promise<Todo | null> {
    const idx = this.todos.findIndex(t => t.id === id);
    if (idx < 0) return null;
    const [removed] = this.todos.splice(idx, 1);
    await this.persist();
    return removed;
  }
}

/** 聊天窗单例（工具与 TodosTab 共用） */
export const todoService = new TodoService();
