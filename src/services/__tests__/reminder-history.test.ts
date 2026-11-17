import { describe, expect, it } from "vitest";

// reminder-history 是纯函数模块（不 import 任何 Tauri API），无需 mock。
import {
  groupHistoryRows,
  historySortKey,
  snoozePlus30,
  tomorrowSameTime,
  type HistoryEntry,
} from "@/services/reminder-history";
import type { Reminder } from "@/services/reminders";

/**
 * 提醒历史的展示层逻辑（P1-02 / v0.14.0）。
 *
 * 这组测试钉住三类边界：
 * 1. **合并批次的判定**——只认 batch_id，不认"同一毫秒"（独立提醒同毫秒触发
 *    不是合并交付，错标成「N 条到点了」会撒谎）；
 * 2. **「再次提醒」的时间推算**——明天同一时间必须落在明天的本地日历上；
 * 3. **排序键**——fired 行按触发时刻、cancelled 行按创建时刻。
 */

/** 构造测试行：只填必填字段，其余按需覆盖；fired 行带真实语义的 firedAt */
function row(overrides: Partial<Reminder> & { id: number }): Reminder {
  const base = {
    text: `提醒 ${overrides.id}`,
    fireAt: 1_700_000_000_000,
    status: "fired" as const,
    createdAt: 1_699_000_000_000,
    repeat: "none" as const,
    ...overrides,
  };
  // 取消行没有触发时刻（firedAt 只属于 fired——与 DB 的 NULL 语义一致）；
  // 显式传入的 firedAt 优先，不被默认值覆盖
  return {
    ...base,
    ...(base.status === "fired" && !("firedAt" in overrides) ? { firedAt: base.fireAt } : {}),
  } as Reminder;
}

describe("groupHistoryRows（批次聚合）", () => {
  it("无批次行全部保持单条，顺序不变", () => {
    const rows = [row({ id: 3 }), row({ id: 1 }), row({ id: 2 })];
    const entries = groupHistoryRows(rows);
    expect(entries.map(e => (e.kind === "single" ? e.reminder.id : -1))).toEqual([3, 1, 2]);
  });

  it("相邻同 batch_id 的行聚合为一条批次，保留原顺序", () => {
    const rows = [
      row({ id: 5, batchId: "batch:100" }),
      row({ id: 6, batchId: "batch:100" }),
      row({ id: 7, batchId: "batch:100" }),
      row({ id: 8 }),
    ];
    const entries = groupHistoryRows(rows);
    expect(entries).toHaveLength(2);
    const batch = entries[0];
    expect(batch.kind).toBe("batch");
    if (batch.kind === "batch") {
      expect(batch.items.map(r => r.id)).toEqual([5, 6, 7]);
      expect(batch.fireAt).toBe(rows[0].firedAt);
    }
  });

  it("同一毫秒触发但 batch_id 为 NULL 的独立行不会误标为合并", () => {
    const sameMs = 1_700_000_000_000;
    const rows = [
      row({ id: 1, firedAt: sameMs }),
      row({ id: 2, firedAt: sameMs }),
    ];
    const entries = groupHistoryRows(rows);
    expect(entries).toHaveLength(2);
    expect(entries.every(e => e.kind === "single")).toBe(true);
  });

  it("batch_id 相同但不相邻的行宁可拆开也不跨段聚合", () => {
    const rows = [
      row({ id: 1, batchId: "batch:100" }),
      row({ id: 2, batchId: "batch:200" }),
      row({ id: 3, batchId: "batch:100" }),
    ];
    const entries = groupHistoryRows(rows);
    expect(entries).toHaveLength(3);
    expect(entries.every(e => e.kind === "single")).toBe(true);
  });

  it("取消行（batch_id NULL）夹在批次中间会拆断批次（理论不发生，宁拆不错聚）", () => {
    const rows = [
      row({ id: 1, batchId: "batch:100" }),
      row({ id: 2, status: "cancelled" }),
      row({ id: 3, batchId: "batch:100" }),
    ];
    expect(groupHistoryRows(rows)).toHaveLength(3);
  });

  it("空输入返回空列表", () => {
    expect(groupHistoryRows([])).toEqual<HistoryEntry[]>([]);
  });
});

describe("historySortKey（历史排序键）", () => {
  it("fired 行用触发时刻", () => {
    expect(historySortKey(row({ id: 1, firedAt: 5_000 }))).toBe(5_000);
  });

  it("cancelled 行没有触发时刻，回创建时刻", () => {
    expect(historySortKey(row({ id: 1, status: "cancelled", createdAt: 3_000 }))).toBe(3_000);
  });
});

describe("snoozePlus30（再次提醒 +30 分钟）", () => {
  it("精确加 30 分钟", () => {
    expect(snoozePlus30(1_000_000)).toBe(1_000_000 + 30 * 60 * 1000);
  });
});

describe("tomorrowSameTime（明天同一时间）", () => {
  it("保留原提醒的本地时分秒，日期推进一天", () => {
    // 原提醒 2026-11-16 09:30 本地；"现在"是 2026-11-17 20:00 → 目标 11-18 09:30
    const fireAt = new Date(2026, 10, 16, 9, 30, 15).getTime();
    const now = new Date(2026, 10, 17, 20, 0, 0).getTime();
    const target = tomorrowSameTime(now, fireAt);
    expect(target).not.toBeNull();
    if (target === null) return;
    const d = new Date(target);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(18);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
    expect(d.getSeconds()).toBe(15);
    expect(target).toBeGreaterThan(now);
  });

  it("结果必然晚于 now（明天的任何时刻都在未来）", () => {
    // now 23:50，原提醒同日 00:05 → 明天 00:05，仍 > now
    const fireAt = new Date(2026, 10, 16, 0, 5).getTime();
    const now = new Date(2026, 10, 17, 23, 50).getTime();
    expect(tomorrowSameTime(now, fireAt)!).toBeGreaterThan(now);
  });

  it("跨月推进正确（11-30 的提醒在 12 月再现）", () => {
    const fireAt = new Date(2026, 10, 30, 8, 0).getTime();
    const now = new Date(2026, 10, 30, 12, 0).getTime();
    const target = tomorrowSameTime(now, fireAt)!;
    const d = new Date(target);
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(8);
  });

  it("非法输入（NaN / Infinity）返回 null，调用方降级为不显示按钮", () => {
    expect(tomorrowSameTime(Number.NaN, 1)).toBeNull();
    expect(tomorrowSameTime(1, Number.NaN)).toBeNull();
    expect(tomorrowSameTime(1, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
