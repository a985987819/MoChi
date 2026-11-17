import { describe, expect, it } from "vitest";
import { clampVolume, configureSound, planFor, playAlert, playClick } from "@/services/sound";

/**
 * 音效（v0.12.0）能自动验证的部分：音符表与音量换算，以及"播不出来也不能抛"。
 * 听感本身无法脚本化——那部分留给真机验收（见版本文档）。
 */
describe("planFor（每种音效的音符表）", () => {
  it("每种音效都有音符，且音量都在 0~1", () => {
    for (const kind of ["click", "standup", "pomodoro", "reminder"] as const) {
      const tones = planFor(kind);
      expect(tones.length).toBeGreaterThan(0);
      for (const tone of tones) {
        expect(tone.hz).toBeGreaterThan(400);
        expect(tone.hz).toBeLessThan(1500); // 太低会闷、太高刺耳
        expect(tone.gain).toBeGreaterThan(0);
        expect(tone.gain).toBeLessThanOrEqual(1);
        expect(tone.ms).toBeGreaterThan(0);
        expect(tone.ms).toBeLessThanOrEqual(400); // 提示音不该拖成长音
      }
    }
  });

  it("点击音最短最轻（高频次操作不能吵）", () => {
    const [click] = planFor("click");
    const [standup] = planFor("standup");
    expect(click.ms).toBeLessThan(standup.ms);
    expect(click.gain).toBeLessThan(standup.gain);
  });

  it("番茄钟用三个音（完成—休息—继续的三段感），其余不超过两个", () => {
    expect(planFor("pomodoro")).toHaveLength(3);
    expect(planFor("standup").length).toBeLessThanOrEqual(2);
    expect(planFor("reminder").length).toBeLessThanOrEqual(2);
  });
});

describe("clampVolume（0~100 → 0~1）", () => {
  it("正常值按百分比换算", () => {
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(30)).toBeCloseTo(0.3);
    expect(clampVolume(100)).toBe(1);
  });

  it("越界夹紧，异常值回落到默认 30%", () => {
    expect(clampVolume(-20)).toBe(0);
    expect(clampVolume(250)).toBe(1);
    expect(clampVolume(Number.NaN)).toBeCloseTo(0.3);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBeCloseTo(0.3);
  });
});

describe("播放健壮性（声音失败绝不能变成新的故障源）", () => {
  it("没有 AudioContext 的环境里播放不抛异常", () => {
    configureSound({ enabled: true, volumePercent: 50, quietHours: { enabled: false, start: 0, end: 0 } });
    expect(() => {
      playClick();
      playAlert("standup");
      playAlert("pomodoro");
      playAlert("reminder");
    }).not.toThrow();
  });

  it("关闭开关后播放直接返回（不创建、不重试）", () => {
    configureSound({ enabled: false, volumePercent: 80, quietHours: { enabled: false, start: 0, end: 0 } });
    expect(() => playClick()).not.toThrow();
  });

  it("免打扰时段内提醒音静默、点击音不受影响（均为不抛异常）", () => {
    configureSound({ enabled: true, volumePercent: 60, quietHours: { enabled: true, start: 0, end: 23 } });
    expect(() => {
      playAlert("reminder");
      playClick();
    }).not.toThrow();
  });
});
