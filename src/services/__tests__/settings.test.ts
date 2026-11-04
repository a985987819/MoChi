import { describe, expect, it } from "vitest";
import { defaultSettings, normalize } from "../settings";

/**
 * 设置归一单测（施工单 §7.1：老配置升级 + 脏数据是真实事故源）。
 * normalize 是 loadSettings 的唯一入口——store 里的任何 JSON 都要经过它。
 */

describe("settings normalize", () => {
  it("非对象输入（null/字符串/数组）→ 全默认", () => {
    for (const raw of [null, undefined, "x", 42, []]) {
      expect(normalize(raw)).toEqual(defaultSettings());
    }
  });

  it("老版本配置（缺新字段）→ 补默认且不丢旧值", () => {
    const old = {
      providerId: "deepseek",
      apiKeys: { deepseek: "sk-old" },
      models: { deepseek: "deepseek-chat" },
      standupIntervalMin: 45,
      pomodoroFocusMin: 30,
      pomodoroBreakMin: 10,
      notificationsEnabled: false,
      // 没有 onboardingDone / shortcutEnabled / autostartEnabled / petScale
    };
    const s = normalize(old);
    expect(s.providerId).toBe("deepseek");
    expect(s.apiKeys).toEqual({ deepseek: "sk-old" });
    expect(s.standupIntervalMin).toBe(45);
    // 升级用户会看到一次引导（v0.9.0 之前没有引导）——期望行为
    expect(s.onboardingDone).toBe(false);
    expect(s.shortcutEnabled).toBe(true);
    expect(s.autostartEnabled).toBe(false);
    expect(s.petScale).toBe(1);
  });

  it("数值越界被夹紧（0/负数/离谱值）", () => {
    const s = normalize({ standupIntervalMin: 0, pomodoroFocusMin: -5, pomodoroBreakMin: 999 });
    expect(s.standupIntervalMin).toBe(1); // 夹到下限
    expect(s.pomodoroFocusMin).toBe(5);
    expect(s.pomodoroBreakMin).toBe(30); // 夹到上限
  });

  it("非数值/NaN 落到默认值", () => {
    const s = normalize({ standupIntervalMin: "60", pomodoroFocusMin: Number.NaN });
    expect(s.standupIntervalMin).toBe(60); // 字符串 → 默认
    expect(s.pomodoroFocusMin).toBe(25);
  });

  it("未知提供商回退 mock", () => {
    expect(normalize({ providerId: "no-such-provider" }).providerId).toBe("mock");
    expect(normalize({ providerId: "deepseek" }).providerId).toBe("deepseek");
  });

  it("嵌套字段类型不对 → 空对象兜底（不抛错）", () => {
    const s = normalize({ apiKeys: "not-an-object", models: 123, notificationsEnabled: "yes" });
    expect(s.apiKeys).toEqual({});
    expect(s.models).toEqual({});
    expect(s.notificationsEnabled).toBe(true);
  });

  it("petScale 只认三档（浮点误差容差内），非法值回落 1", () => {
    expect(normalize({ petScale: 0.8 }).petScale).toBe(0.8);
    expect(normalize({ petScale: 1.2 }).petScale).toBe(1.2);
    expect(normalize({ petScale: 0.9 }).petScale).toBe(1); // 非档位
    expect(normalize({ petScale: 0.80000000001 }).petScale).toBe(0.8); // 浮点误差容差
    expect(normalize({ petScale: "1" }).petScale).toBe(1); // 类型不对
  });
});
