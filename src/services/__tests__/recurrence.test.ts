import { describe, expect, it } from "vitest";
import { nextOccurrence, parseRepeat } from "@/services/recurrence";

/**
 * 周期提醒的下一次推算（v0.13.0）。
 *
 * 全部用**本地时间**构造（`new Date(y, m, d, h, m)`）：函数的语义就是本地日历，
 * 用 UTC 字符串构造会让断言在非 UTC 机器上偶发失败。2026-11-17 是周二。
 */
const at = (day: number, hour = 9, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();

describe("nextOccurrence（daily / weekdays / weekly）", () => {
  it("每天：从今天 9:00 推到明天 9:00，时分保留", () => {
    const fireAt = at(17, 9, 30);
    expect(nextOccurrence(fireAt, "daily", at(17, 10))).toBe(at(18, 9, 30));
  });

  it("每天：即使已经过了一周也只给**一个**未来时刻（不补发一串）", () => {
    // 上次触发是 11-10，现在 11-17 10:00 → 下一次 11-18 09:00，而不是 11-11..11-17 全排一遍
    expect(nextOccurrence(at(10), "daily", at(17, 10))).toBe(at(18));
  });

  it("工作日：周五触发后下一次是下周一（跳过周末）", () => {
    // 2026-11-20 是周五
    expect(nextOccurrence(at(20), "weekdays", at(20, 10))).toBe(at(23));
  });

  it("工作日：周末触发也落到下周一（防御脏数据）", () => {
    // 2026-11-21 是周六
    expect(nextOccurrence(at(21), "weekdays", at(21, 10))).toBe(at(23));
  });

  it("每周：保持同一星期几，加 7 天", () => {
    // 周二 → 下周二
    expect(nextOccurrence(at(17), "weekly", at(17, 10))).toBe(at(24));
    // 跨月的周节奏同样成立（11-24 → 12-01）
    expect(nextOccurrence(at(24), "weekly", at(24, 10))).toBe(new Date(2026, 11, 1, 9, 0, 0, 0).getTime());
  });

  it("一次性 / 非法输入返回 null", () => {
    expect(nextOccurrence(at(17), "none", at(17, 10))).toBeNull();
    expect(nextOccurrence(Number.NaN, "daily", at(17, 10))).toBeNull();
  });

  it("结果一定严格晚于 after（调用方据此判断还能不能排）", () => {
    const next = nextOccurrence(at(17), "daily", at(17, 10));
    expect(next).not.toBeNull();
    expect(next as number).toBeGreaterThan(at(17, 10));
  });
});

describe("parseRepeat（DB / 工具参数的兜底）", () => {
  it("合法值原样返回", () => {
    expect(parseRepeat("daily")).toBe("daily");
    expect(parseRepeat("weekdays")).toBe("weekdays");
    expect(parseRepeat("weekly")).toBe("weekly");
    expect(parseRepeat("none")).toBe("none");
  });

  it("未知值 / 非字符串一律按一次性处理", () => {
    expect(parseRepeat("hourly")).toBe("none");
    expect(parseRepeat(null)).toBe("none");
    expect(parseRepeat(42)).toBe("none");
    expect(parseRepeat(undefined)).toBe("none");
  });
});
