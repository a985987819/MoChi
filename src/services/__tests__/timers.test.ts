import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { STATE_EVENTS, UI_EVENTS } from "@/shared/events";
import { petState } from "@/services/pet-state";
import { StandupService, PomodoroService } from "@/services/timers";

const deps = vi.hoisted(() => ({
  config: { standupIntervalMin: 1, pomodoroFocusMin: 5, pomodoroBreakMin: 1, notificationsEnabled: false },
  presence: { current: "active" },
  notify: vi.fn(),
}));
vi.mock("@/services/settings", () => ({ loadSettings: async () => ({ ...deps.config }) }));
vi.mock("@/services/presence", () => ({ presenceService: deps.presence }));
vi.mock("@/services/notifications", () => ({ notify: deps.notify }));

beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  mockIPC(() => undefined, { shouldMockEvents: true });
  deps.config = { standupIntervalMin: 1, pomodoroFocusMin: 5, pomodoroBreakMin: 1, notificationsEnabled: false };
  deps.presence.current = "active";
  deps.notify.mockClear();
  petState.clearSystem();
  for (const owner of ["standup", "pomodoro", "reminder"]) petState.clearSystem(owner);
});
afterEach(() => { vi.clearAllTimers(); clearMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("番茄钟实际时间与状态联动", () => {
  it("进行中修改设置只影响下一轮，当前休息时长保持启动值", async () => {
    const pomo = new PomodoroService();
    await pomo.start();
    pomo.startFocus();
    deps.config.pomodoroBreakMin = 3;
    await emit(STATE_EVENTS.settingsChanged);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(pomo.status().remainingSec).toBe(60);
    pomo.stop();
    pomo.startFocus();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(pomo.status().remainingSec).toBe(180);
  });
  it("专注→休息→空闲，只通知两次且不自动续轮", async () => {
    deps.config.notificationsEnabled = true;
    const pomo = new PomodoroService();
    await pomo.start();
    pomo.startFocus();
    expect(pomo.status()).toMatchObject({ phase: "focus", remainingSec: 300 });
    expect(petState.current).toBe("focus");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(pomo.status()).toMatchObject({ phase: "break", remainingSec: 60 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pomo.status().phase).toBe("idle");
    expect(deps.notify).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(pomo.status().phase).toBe("idle");
  });

  it("重复启动不重置正在进行的专注，停止后倒计时归零", async () => {
    const pomo = new PomodoroService();
    await pomo.start();
    pomo.startFocus();
    await vi.advanceTimersByTimeAsync(10_000);
    pomo.startFocus(10);
    expect(pomo.status().remainingSec).toBe(290);
    pomo.stop();
    expect(pomo.status()).toMatchObject({ phase: "idle", remainingSec: 0 });
  });

  it.each([0, -1, 91, NaN, Infinity])("服务端拒绝非法时长 %s", async minutes => {
    const pomo = new PomodoroService();
    await pomo.start();
    pomo.startFocus(minutes);
    expect(pomo.status().phase).toBe("idle");
  });

  it("挂起后按绝对时间补发阶段结束，连续 tick 不重复通知", async () => {
    deps.config.notificationsEnabled = true;
    const pomo = new PomodoroService();
    await pomo.start();
    pomo.startFocus();
    vi.setSystemTime(Date.now() + 600_000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(pomo.status().phase).toBe("break");
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });
});

describe("站立提醒闭环", () => {
  it("站立间隔改变时按新间隔从头计时", async () => {
    const standup = new StandupService();
    await standup.start();
    await vi.advanceTimersByTimeAsync(59_000);
    deps.config.standupIntervalMin = 2;
    await emit(STATE_EVENTS.settingsChanged);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(standup.state).toBe("armed");
    await vi.advanceTimersByTimeAsync(1000);
    expect(standup.state).toBe("fired");
    await emit(UI_EVENTS.standupAck);
  });
  it("离开时推迟，恢复活动后补弹一次", async () => {
    const standup = new StandupService();
    await standup.start();
    deps.presence.current = "away";
    await vi.advanceTimersByTimeAsync(90_000);
    expect(standup.state).toBe("armed");
    deps.presence.current = "active";
    await vi.advanceTimersByTimeAsync(1000);
    expect(standup.state).toBe("fired");
    expect(petState.current).toBe("alert");
    await emit(UI_EVENTS.standupAck);
  });

  it("点击弹窗后 stretch 两秒，再重新计时", async () => {
    const standup = new StandupService();
    await standup.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await emit(UI_EVENTS.standupAck);
    expect(standup.state).toBe("armed");
    expect(petState.current).toBe("stretch");
    await vi.advanceTimersByTimeAsync(2000);
    expect(petState.current).toBe("idle");
  });

  it("超时自动收尾必须通知原生窗口隐藏", async () => {
    const emitted: string[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "plugin:event|emit" && args && "event" in args) emitted.push(String(args.event));
    });
    const standup = new StandupService();
    await standup.start();
    await vi.advanceTimersByTimeAsync(660_000);
    expect(standup.state).toBe("armed");
    expect(emitted).toContain("ui://hide-alert");
  });

  it("更改通知等无关设置不会重置站立倒计时", async () => {
    const standup = new StandupService();
    await standup.start();
    await vi.advanceTimersByTimeAsync(59_000);
    deps.config.notificationsEnabled = true;
    await emit(STATE_EVENTS.settingsChanged);
    await vi.advanceTimersByTimeAsync(1000);
    expect(standup.state).toBe("fired");
    await emit(UI_EVENTS.standupAck);
  });

  it("单击宠物关闭已显示的提醒并重新计时", async () => {
    const emitted: string[] = [];
    const { listen } = await import("@tauri-apps/api/event");
    await listen("ui://hide-alert", () => emitted.push("hide"));
    const standup = new StandupService();
    await standup.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await emit(UI_EVENTS.resetStandup);
    expect(standup.state).toBe("armed");
    expect(emitted).toContain("hide");
  });

  it("站立提醒结束后恢复专注，停止番茄钟不会抹掉站立提醒", async () => {
    const pomo = new PomodoroService();
    const standup = new StandupService();
    await pomo.start();
    await standup.start();
    pomo.startFocus();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(petState.current).toBe("alert");
    await emit(UI_EVENTS.standupAck);
    await vi.advanceTimersByTimeAsync(2000);
    expect(petState.current).toBe("focus");
    await vi.advanceTimersByTimeAsync(58_000);
    pomo.stop();
    expect(petState.current).toBe("alert");
    await emit(UI_EVENTS.standupAck);
  });
});
