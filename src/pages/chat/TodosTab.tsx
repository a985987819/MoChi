import { useCallback, useEffect, useState } from "react";
import { todoService, type Todo } from "@/services/todos";
import { Loading } from "@/shared/components/Loading";

/**
 * 待办 Tab —— v0.4.0：待办的 UI 通道（learning/07 §3 双入口模式的 UI 侧）。
 * Agent 的 add_todo/complete_todo/delete_todo 与这里的按钮/勾选汇入同一个
 * TodoService——两边看到的状态永远一致（订阅 snapshot 刷新）。
 */
export function TodosTab() {
  const [todos, setTodos] = useState<Todo[] | null>(null); // null=加载中（区别于"空"）
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let off: (() => void) | undefined;
    void todoService.ready
      .then(() => {
        setTodos(todoService.snapshot());
        off = todoService.subscribe(() => setTodos(todoService.snapshot()));
      })
      .catch(() => setLoadError(true)); // SQLite 被锁/损坏：给出可见失败，监督器稍后重试 ready
    return () => off?.();
  }, []);

  const pending = (todos ?? []).filter(t => !t.done);
  const done = (todos ?? []).filter(t => t.done);

  const add = useCallback(() => {
    const title = draft.trim();
    if (!title) return;
    todoService.add(title); // UI 通道：不带 due（时间语义让 Agent 的工具去承接）
    setDraft("");
  }, [draft]);

  return (
    <div className="todos-panel">
      <div className="todos-add">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) add();
          }}
          placeholder="手动加一条待办…"
        />
        <button onClick={add} disabled={!draft.trim()}>
          添加
        </button>
      </div>

      {todos === null && !loadError && <Loading label="正在读取待办…" />}
      {loadError && <p className="todos-empty" role="alert">待办读取失败（数据库暂不可用），稍后自动重试。</p>}
      {(todos ?? []).length === 0 && todos !== null && !loadError && (
        <p className="todos-empty">
          还没有待办。
          <br />
          试试对麻薯说：<strong>帮我加个待办：明天九点开周会</strong>
        </p>
      )}

      {pending.length > 0 && <div className="todos-section">未完成 · {pending.length}</div>}
      {pending.map(t => (
        <TodoRow key={t.id} todo={t} />
      ))}

      {done.length > 0 && <div className="todos-section">已完成 · {done.length}</div>}
      {done.map(t => (
        <TodoRow key={t.id} todo={t} />
      ))}
    </div>
  );
}

function TodoRow({ todo }: { todo: Todo }) {
  const toggle = useCallback(() => {
    if (!todo.done) void todoService.complete(todo.id);
  }, [todo]);

  const remove = useCallback(() => {
    void todoService.remove(todo.id);
  }, [todo]);

  return (
    <div className={`todo-row${todo.done ? " todo-row--done" : ""}`}>
      <button
        className="todo-row__check"
        onClick={toggle}
        disabled={todo.done}
        aria-label={todo.done ? "已完成" : "标记完成"}
      >
        {todo.done ? "✓" : ""}
      </button>
      <div className="todo-row__body">
        <span className="todo-row__title">{todo.title}</span>
        {todo.due && <span className="todo-row__due">{todo.due}</span>}
      </div>
      <button className="todo-row__del" onClick={remove} aria-label="删除">
        ×
      </button>
    </div>
  );
}
