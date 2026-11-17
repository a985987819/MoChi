import { describe, expect, it, vi } from "vitest";

// system-events 顶部 import 了 Tauri 事件模块；纯函数测试不需要真桥。
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));

import { BURST_GAP_MS, RESUME_GAP_MS, classifyTickGap, formatBatchBody } from "@/services/system-events";

/**
 * 休眠恢复判定（v0.11.0）。
 *
 * 这三个阈值决定"要不要合并提醒"：判太敏感，普通卡顿就会把两条提醒并成一条；
 * 判太迟钝，合盖一夜后照样连弹五个。所以边界值必须钉死。
 */
describe("classifyTickGap（节拍间隔语义）", () => {
  it("正常节拍不产生事件", () => {
    expect(classifyTickGap(0)).toBeNull();
    expect(classifyTickGap(1000)).toBeNull();
    expect(classifyTickGap(RESUME_GAP_MS - 1)).toBeNull();
  });

  it("超过 5 秒算一次恢复", () => {
    expect(classifyTickGap(RESUME_GAP_MS)).toBe("resume");
    expect(classifyTickGap(30_000)).toBe("resume");
    expect(classifyTickGap(BURST_GAP_MS - 1)).toBe("resume");
  });

  it("超过 5 分钟算长休眠，需要合并提醒", () => {
    expect(classifyTickGap(BURST_GAP_MS)).toBe("burst");
    expect(classifyTickGap(8 * 60 * 60 * 1000)).toBe("burst"); // 睡了一夜
  });

  it("异常数值不触发（NaN / 负数都当作正常节拍）", () => {
    expect(classifyTickGap(Number.NaN)).toBeNull();
    expect(classifyTickGap(-1)).toBeNull();
  });
});

describe("formatBatchBody（合并提醒正文）", () => {
  it("少于上限时逐条列出", () => {
    expect(formatBatchBody(["喝水", "站起来"])).toBe("喝水；站起来");
  });

  it("超过上限用「等 N 条」收尾", () => {
    expect(formatBatchBody(["a", "b", "c", "d", "e", "f", "g"])).toBe("a；b；c；d；e；等 2 条");
  });

  it("空文本被剔除，全空时返回空串（调用方据此决定不弹）", () => {
    expect(formatBatchBody(["  ", ""])).toBe("");
    expect(formatBatchBody(["喝水", "   "])).toBe("喝水");
  });
});
