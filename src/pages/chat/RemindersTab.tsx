import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";
import { reminderStore, type Reminder } from "@/services/reminders";
import { snoozePlus30, tomorrowSameTime, type HistoryEntry } from "@/services/reminder-history";

/**
 * 提醒中心（P1-02 / v0.14.0）——只回答一个问题：「提醒过什么」。
 *
 * 两个分区的数据源都是 reminders 表（单一事实源，跨窗口一致）：
 * - **进行中**：status='active'，未触发的待办式列表（取消入口）；
 * - **历史**：status IN ('fired','cancelled')，倒序分页。合并交付（v0.11.0 长休眠
 *   恢复）的整批按 batch_id 聚合为一条「N 条到点了」，展开可看每条原文。
 *
 * 「再次提醒」是纯 create(text, target)：复用现有 Store 的唯一插入路径，
 * 不写第二条 SQL——新的提醒同样经调度器触发生成历史，闭环不引新状态。
 *
 * 为什么从番茄钟 Tab 拆出来：v0.7.0 把提醒列表寄在番茄钟页是因为当时没有更
 * 合适的宿主；提醒有了自己的历史之后，「提醒中心」是独立的心智单元（番茄钟
 * 是计时器，提醒是承诺），塞在一起会让两个 Tab 都更难找东西。
 */

/** 每页行数：与 SQL LIMIT 对齐；加载更多按行推进 offset（与条目数无关） */
const PAGE_SIZE = 20;

/** 周期标签与番茄钟页共用一套语义（v0.13.0） */
const REPEAT_LABEL = { daily: "每天", weekdays: "工作日", weekly: "每周" } as const;

export function RemindersTab() {
  const [active, setActive] = useState<Reminder[]>([]);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [pending, setPending] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  /** 已取回的历史行数（不是条目数）：offset 的真相 */
  const rowsRead = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [activeList, page] = await Promise.all([
        reminderStore.listActive(),
        reminderStore.listHistory(PAGE_SIZE, 0),
      ]);
      setActive(activeList);
      setEntries(page.entries);
      setHasMore(page.hasMore);
      rowsRead.current = PAGE_SIZE; // 服务端 offset 恒按行推进
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "提醒数据读取失败，请稍后重试");
    } finally {
      setPending(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await reminderStore.listHistory(PAGE_SIZE, rowsRead.current);
      setEntries(prev => [...prev, ...page.entries]);
      setHasMore(page.hasMore);
      rowsRead.current += PAGE_SIZE;
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "更多历史读取失败");
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore]);

  // remindersChanged（创建/取消/触发/确认）→ 重读第一页。变更不频繁，整页刷新
  // 比增量维护两条列表简单可靠；深翻页后遇变更回到顶部是可接受的取舍。
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void refresh();
    void listen(STATE_EVENTS.remindersChanged, () => {
      if (!disposed) void refresh();
    }).then(unlisten => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [refresh]);

  const cancel = useCallback((id: number) => {
    void reminderStore.cancel(id).catch(() => setError("取消失败，请重试"));
  }, []);

  const snooze = useCallback(async (text: string, target: number) => {
    try {
      await reminderStore.create(text, target);
    } catch {
      setError("创建提醒失败，请重试");
    }
  }, []);

  const now = Date.now();

  return (
    <div className="rem-panel">
      <section className="rem-section">
        <span className="rem-section__title">进行中（{active.length}）</span>
        {pending ? (
          <p className="rem-hint">读取中…</p>
        ) : (
          active.length === 0 && (
            <p className="rem-hint">还没有进行中的提醒。对麻薯说「帮我明天九点提醒交周报」试试</p>
          )
        )}
        {active.map(r => (
          <div key={r.id} className="rem-item">
            <div className="rem-item__main">
              <span className="rem-item__text">{r.text}</span>
              <span className="rem-item__time">
                {r.repeat !== "none" && <span className="rem-chip">{REPEAT_LABEL[r.repeat]}</span>}
                {Number.isFinite(r.fireAt)
                  ? new Date(r.fireAt).toLocaleString("zh-CN", {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : ""}
              </span>
            </div>
            <button onClick={() => cancel(r.id)} aria-label="取消提醒">
              ×
            </button>
          </div>
        ))}
      </section>

      <section className="rem-section">
        <span className="rem-section__title">历史</span>
        {error && (
          <p className="rem-hint rem-hint--error" role="alert">
            {error}
          </p>
        )}
        {!pending && entries.length === 0 && !error && (
          <p className="rem-hint">还没有提醒历史。触发或取消的提醒会留在这里</p>
        )}
        {entries.map((entry, index) =>
          entry.kind === "single" ? (
            <HistorySingle key={`s${entry.reminder.id}`} reminder={entry.reminder} now={now} onSnooze={snooze} />
          ) : (
            <HistoryBatch key={`b${entry.items[0]?.id ?? index}`} fireAt={entry.fireAt} items={entry.items} now={now} onSnooze={snooze} />
          ),
        )}
        {hasMore && (
          <button className="rem-more" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        )}
      </section>
    </div>
  );
}

/** 单条历史：状态徽标 + 正文（两行截断）+ 一次性提醒的「再次提醒」按钮 */
function HistorySingle({
  reminder: r,
  now,
  onSnooze,
}: {
  reminder: Reminder;
  now: number;
  onSnooze: (text: string, target: number) => Promise<void>;
}) {
  const tomorrow = tomorrowSameTime(now, r.fireAt);
  return (
    <div className="rem-item">
      <StatusChip reminder={r} />
      <div className="rem-item__main">
        <span className="rem-item__text">{r.text}</span>
        <span className="rem-item__time">
          {r.repeat !== "none" && <span className="rem-chip">{REPEAT_LABEL[r.repeat]}</span>}
          {Number.isFinite(historyTime(r))
            ? new Date(historyTime(r)).toLocaleString("zh-CN", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : ""}
        </span>
      </div>
      {/* 只有一次性提醒显示「再次提醒」：周期提醒的下一轮已经自动排好了，
          再手动补一条会出现同一时段两条——按钮少比数据错好 */}
      {r.repeat === "none" && (
        <div className="rem-item__actions">
          <button onClick={() => void onSnooze(r.text, snoozePlus30(now))}>+30 分钟</button>
          {tomorrow !== null && (
            <button onClick={() => void onSnooze(r.text, tomorrow)}>明天同一时间</button>
          )}
        </div>
      )}
    </div>
  );
}

/** 合并交付批次（v0.11.0）：默认收起为一行，展开看每条原文与再次提醒 */
function HistoryBatch({
  fireAt,
  items,
  now,
  onSnooze,
}: {
  fireAt: number;
  items: Reminder[];
  now: number;
  onSnooze: (text: string, target: number) => Promise<void>;
}) {
  return (
    <details className="rem-batch">
      <summary>
        <span className="rem-chip rem-chip--muted">合并交付</span>
        <div className="rem-item__main">
          <span className="rem-item__text">⏰ {items.length} 条提醒到点了</span>
          <span className="rem-item__time">
            {Number.isFinite(fireAt)
              ? new Date(fireAt).toLocaleString("zh-CN", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : ""}
          </span>
        </div>
      </summary>
      {items.map(item => {
        const tomorrow = tomorrowSameTime(now, item.fireAt);
        return (
          <div key={item.id} className="rem-batch__item">
            <span className="rem-batch__text">{item.text}</span>
            {item.repeat === "none" && (
              <div className="rem-item__actions">
                <button onClick={() => void onSnooze(item.text, snoozePlus30(now))}>+30 分钟</button>
                {tomorrow !== null && (
                  <button onClick={() => void onSnooze(item.text, tomorrow)}>明天同一时间</button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </details>
  );
}

/** 状态徽标：已取消 / 待确认（触发后没点过弹窗）/ 已触发 */
function StatusChip({ reminder: r }: { reminder: Reminder }) {
  const label = r.status === "cancelled" ? "已取消" : r.acknowledgedAt == null ? "待确认" : "已触发";
  const tone = r.status === "cancelled" ? "muted" : r.acknowledgedAt == null ? "warn" : "ok";
  return <span className={`rem-chip rem-chip--${tone}`}>{label}</span>;
}

/** 历史行的时间：触发时刻优先，取消行没有触发时刻就回创建时刻 */
function historyTime(r: Reminder): number {
  return r.firedAt ?? r.createdAt;
}
