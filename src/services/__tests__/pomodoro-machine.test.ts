import { describe, expect, it } from "vitest";
import { advancePomodoro } from "../pomodoro-machine";

describe("advancePomodoro（番茄钟阶段迁移）", () => {
  it("未到点：任何阶段原地不动", () => {
    expect(advancePomodoro("idle", false)).toEqual({ phase: "idle", completed: null });
    expect(advancePomodoro("focus", false)).toEqual({ phase: "focus", completed: null });
    expect(advancePomodoro("break", false)).toEqual({ phase: "break", completed: null });
  });

  it("focus 到点 → break，报告完成的是专注", () => {
    expect(advancePomodoro("focus", true)).toEqual({ phase: "break", completed: "focus" });
  });

  it("break 到点 → idle，且**不自动续轮**（learning/08 §4.3 产品承诺）", () => {
    const next = advancePomodoro("break", true);
    expect(next.phase).toBe("idle");
    expect(next.phase).not.toBe("focus"); // 主动承诺才叫专注
    expect(next.completed).toBe("break");
  });

  it("idle 没有「到点」概念：timeUp=true 也原地不动", () => {
    expect(advancePomodoro("idle", true)).toEqual({ phase: "idle", completed: null });
  });
});
