import { expect, it, vi } from "vitest";
import { startPomodoroTool, stopPomodoroTool, pomodoroStatusTool } from "@/agent/tools/pomodoro";
import type { ToolContext } from "@/agent/tools/registry";
import type { PomodoroControl } from "@/services/pomodoro-control";

// 本组工具通过闭包注入应用遥控，不读取 ToolContext；其余应用服务无需构造。
const ctx = {} as ToolContext;
function control(): PomodoroControl {
  return {
    start: vi.fn(async () => ({ ok: true as const, data: { phase: "focus" as const, remainingSec: 600, focusMin: 10 } })),
    stop: vi.fn(async () => ({ ok: true as const, data: { phase: "idle" as const, remainingSec: 0, focusMin: 10 } })),
    status: vi.fn(async () => ({ ok: true as const, data: { phase: "focus" as const, remainingSec: 600, focusMin: 10 } })),
  };
}

it("工具确认使用宿主返回的设置时长，不硬编码 25 分钟", async () => {
  const ctl = control();
  expect(await startPomodoroTool(ctl).execute({}, ctx)).toEqual({ ok: true, data: { message: "番茄钟已开始（10 分钟）" } });
});
it("时长越界不下发命令", async () => {
  const ctl = control();
  expect((await startPomodoroTool(ctl).execute({ minutes: 0 }, ctx)).ok).toBe(false);
  expect(ctl.start).not.toHaveBeenCalled();
});
it("启动与停止的服务失败均如实返回", async () => {
  const ctl = control();
  ctl.start = async () => ({ ok: false, error: "重复启动" });
  ctl.stop = async () => ({ ok: false, error: "未响应" });
  expect(await startPomodoroTool(ctl).execute({}, ctx)).toEqual({ ok: false, error: "重复启动" });
  expect(await stopPomodoroTool(ctl).execute({}, ctx)).toEqual({ ok: false, error: "未响应" });
});
it("查询读取宿主当前结果，失败不能当作空闲", async () => {
  const ctl = control();
  expect(await pomodoroStatusTool(ctl).execute({}, ctx)).toEqual({ ok: true, data: { phase: "focus", remaining_min: 10 } });
  ctl.status = async () => ({ ok: false, error: "未响应" });
  expect((await pomodoroStatusTool(ctl).execute({}, ctx)).ok).toBe(false);
});
