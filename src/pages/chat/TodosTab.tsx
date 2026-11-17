import { useCallback, useEffect, useState } from "react";
import { todoService, type Todo } from "@/services/todos";
import { Loading } from "@/shared/components/Loading";
import { useT } from "@/shared/i18n/react";

/**
 * 待办 Tab —— v0.4.0：待办的 UI 通道（learning/07 §3 双入口模式的 UI 侧）。
 * Agent 的 add_todo/complete_todo/delete_todo 与这里的按钮/勾选汇入同一个
 * TodoService——两边看到的状态永远一致（订阅 snapshot 刷新）。
 * v0.19.0：文案走 i18n（P2-03B）。
 */
export function TodosTab() {
  const { t } = useT();
  const [todos, setTodos] = useState<Todo[] | null>(null); // null=加载中（区别于"空"）
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState("");
  /** 可选到期时间（datetime-local 的值，如 "2026-11-18T09:00"） */
  const [dueAt, setDueAt] = useState("");

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
    // v0.13.0：可选的"到点提醒"。datetime-local 无时区信息，按本地时间解释（与用户直觉一致）；
    // 空值 = 只记清单，不挂提醒。
    const dueAtMs = dueAt ? new Date(dueAt).getTime() : undefined;
    todoService.add(title, undefined, Number.isFinite(dueAtMs) ? dueAtMs : undefined);
    setDraft("");
    setDueAt("");
  }, [draft, dueAt]);

  return (
    <div className="todos-panel">
      <div className="todos-add">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) add();
          }}
          placeholder={t("todos.placeholder")}
        />
        <button onClick={add} disabled={!draft.trim()}>
          {t("todos.add")}
        </button>
      </div>
      <label className="todos-due">
        <span>{t("todos.dueLabel")}</span>
        <input
          type="datetime-local"
          value={dueAt}
          onChange={e => setDueAt(e.target.value)}
        />
      </label>

      {todos === null && !loadError && <Loading label={t("todos.loading")} />}
      {loadError && (
        <p className="todos-empty" role="alert">
          {t("todos.loadError")}
        </p>
      )}
      {(todos ?? []).length === 0 && todos !== null && !loadError && (
        <p className="todos-empty">
          {t("todos.emptyLine")}
          <br />
          {t("todos.emptyPrompt")}
          <strong>{t("todos.emptyExample")}</strong>
        </p>
      )}

      {pending.length > 0 && <div className="todos-section">{t("todos.sectionPending", { count: pending.length })}</div>}
      {pending.map(todo => (
        <TodoRow key={todo.id} todo={todo} />
      ))}

      {done.length > 0 && <div className="todos-section">{t("todos.sectionDone", { count: done.length })}</div>}
      {done.map(todo => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
    </div>
  );
}

/**
 * 到期时间展示（v0.13.0）：今天/明天用相对词（一眼能判断紧迫度），更远的显示月日时分。
 * 不在渲染层做"还剩几分钟"——那需要每秒重渲染，收益很小。
 * v0.19.0：相对词走 i18n；时间本身仍按本地格式（zh-CN 是显示格式不是语言选择——
 * 英文界面也用同样简洁的月日时分，保持信息密度）。
 */
function formatDueAt(ms: number, t: (key: "todos.dueToday" | "todos.dueTomorrow", vars?: Record<string, string | number>) => string): string {
  const date = new Date(ms);
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(date, now)) return t("todos.dueToday", { time });
  if (sameDay(date, tomorrow)) return t("todos.dueTomorrow", { time });
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function TodoRow({ todo }: { todo: Todo }) {
  const { t } = useT();
  const toggle = useCallback(() => {
    if (!todo.done) void todoService.complete(todo.id);
  }, [todo]);

  const remove = useCallback(() => {
    void todoService.remove(todo.id);
  }, [todo]);

  const overdue = todo.dueAt != null && !todo.done && todo.dueAt < Date.now();

  return (
    <div className={`todo-row${todo.done ? " todo-row--done" : ""}`}>
      <button
        className="todo-row__check"
        onClick={toggle}
        disabled={todo.done}
        aria-label={todo.done ? t("todos.ariaDone") : t("todos.ariaMarkDone")}
      >
        {todo.done ? "✓" : ""}
      </button>
      <div className="todo-row__body">
        <span className="todo-row__title">{todo.title}</span>
        {todo.due && <span className="todo-row__due">{todo.due}</span>}
        {todo.dueAt != null && (
          <span className={`todo-row__due${overdue ? " todo-row__due--overdue" : ""}`}>
            ⏰ {formatDueAt(todo.dueAt, t)}
          </span>
        )}
      </div>
      <button className="todo-row__del" onClick={remove} aria-label={t("todos.ariaDelete")}>
        ×
      </button>
    </div>
  );
}
