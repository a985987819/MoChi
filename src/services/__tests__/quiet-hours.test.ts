import { describe, expect, it } from "vitest";
import { isQuietHour, quietEndAt } from "@/services/quiet-hours";

/**
 * 免打扰时段（v0.10.0）判定表。
 *
 * 为什么值得单测：这函数决定"半夜会不会把人吵醒"和"白天会不会一整天不提醒"。
 * 两种错法的代价都很高，而跨午夜的分支又恰好是最容易写反的地方。
 */
const at = (hour: number, minute = 0) => new Date(2026, 10, 17, hour, minute, 0, 0);

describe("isQuietHour（跨午夜 / 日间 / 退化）", () => {
  it("跨午夜时段：22 点到次日 8 点", () => {
    expect(isQuietHour(at(22).getTime(), 22, 8)).toBe(true);
    expect(isQuietHour(at(23, 30).getTime(), 22, 8)).toBe(true);
    expect(isQuietHour(at(0, 30).getTime(), 22, 8)).toBe(true);
    expect(isQuietHour(at(7, 59).getTime(), 22, 8)).toBe(true);
    expect(isQuietHour(at(8).getTime(), 22, 8)).toBe(false); // 整点恢复
    expect(isQuietHour(at(12).getTime(), 22, 8)).toBe(false);
    expect(isQuietHour(at(21, 59).getTime(), 22, 8)).toBe(false);
  });

  it("同日时段：9 点到 17 点，左闭右开", () => {
    expect(isQuietHour(at(9).getTime(), 9, 17)).toBe(true);
    expect(isQuietHour(at(16, 59).getTime(), 9, 17)).toBe(true);
    expect(isQuietHour(at(17).getTime(), 9, 17)).toBe(false);
    expect(isQuietHour(at(8, 59).getTime(), 9, 17)).toBe(false);
  });

  it("起止相同视为未设置（否则会变成全天静音）", () => {
    for (const hour of [0, 8, 12, 23]) {
      expect(isQuietHour(at(hour).getTime(), 8, 8)).toBe(false);
    }
  });
});

describe("quietEndAt（把站立提醒推迟到时段结束）", () => {
  it("半夜处于时段内 → 结束时刻是次日整点", () => {
    expect(quietEndAt(at(23).getTime(), 22, 8)).toBe(new Date(2026, 10, 18, 8, 0, 0, 0).getTime());
  });

  it("凌晨处于时段内 → 结束时刻是当天整点", () => {
    expect(quietEndAt(at(7).getTime(), 22, 8)).toBe(new Date(2026, 10, 17, 8, 0, 0, 0).getTime());
  });

  it("不在时段内 → null（调用方不该改 deadline）", () => {
    expect(quietEndAt(at(12).getTime(), 22, 8)).toBeNull();
    expect(quietEndAt(at(8).getTime(), 22, 8)).toBeNull();
  });
});
