/**
 * pomodoro_* 工具 —— 番茄钟的 Agent 通道（learning/07 §4.3 双入口的 Agent 侧；
 * UI 通道在 PomodoroTab）。规格：docs/learning/08-timers-reminders-presence.md §4.4。
 *
 * PomodoroService 驻留宠物窗（常宿主），本组工具经 state://pomodoro-start/stop
 * 跨窗口遥控；状态查询读 chat 窗缓存的最近一次广播（番茄钟 Tab 打开时缓存必然新鲜）。
 * 参数边界校验在工具层（5~90 分钟），越界返回 ok:false 让模型向用户澄清。
 */

import type { ToolDefinition } from "./registry";

/** 广播载荷的宽松形状（phase 用字符串而非 union：跨窗口载荷不做类型强约束） */
export interface PomodoroStatusLite {
  phase: string;
  remainingSec: number;
}

/** chat 窗侧遥控 + 状态缓存（由 Facade 注入实现） */
export interface PomodoroControl {
  start(minutes?: number): void;
  stop(): void;
  /** 最近一次广播的状态；从未广播过（应用刚启动）返回 null */
  cachedStatus(): PomodoroStatusLite | null;
}

export function startPomodoroTool(ctl: PomodoroControl): ToolDefinition<{ minutes?: number }> {
  return {
    name: "start_pomodoro",
    description:
      "启动一个番茄钟专注（默认 25 分钟）。用户说'来个番茄钟'/'专注一会儿'时使用。" +
      "已在专注中时调用会失败。专注结束与休息结束会有系统通知。",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "number", description: "专注时长（分钟），可选，默认 25" },
      },
    },
    risk: "write",
    async execute(args) {
      if (args.minutes != null && !(args.minutes >= 5 && args.minutes <= 90)) {
        return { ok: false as const, error: "专注时长需在 5~90 分钟之间，请向用户确认" };
      }
      const status = ctl.cachedStatus();
      if (status?.phase === "focus") {
        return {
          ok: false as const,
          error: `已有番茄钟在专注中（剩余 ${Math.ceil(status.remainingSec / 60)} 分钟），可先停止或等它结束`,
        };
      }
      ctl.start(args.minutes);
      return { ok: true as const, data: { message: `番茄钟已开始（${args.minutes ?? 25} 分钟）` } };
    },
  };
}

export function stopPomodoroTool(ctl: PomodoroControl): ToolDefinition<Record<string, never>> {
  return {
    name: "stop_pomodoro",
    description: "停止当前番茄钟（用户说'停下番茄钟'/'不专注了'时使用）。",
    parameters: { type: "object", properties: {} },
    risk: "write",
    async execute() {
      ctl.stop();
      return { ok: true as const, data: { message: "番茄钟已停止" } };
    },
  };
}

export function pomodoroStatusTool(ctl: PomodoroControl): ToolDefinition<Record<string, never>> {
  return {
    name: "get_pomodoro_status",
    description: "查询番茄钟当前状态（阶段与剩余时间）。",
    parameters: { type: "object", properties: {} },
    risk: "read",
    async execute() {
      const status = ctl.cachedStatus();
      if (!status || status.phase === "idle") {
        return { ok: true as const, data: { phase: "idle", message: "当前没有进行中的番茄钟" } };
      }
      return {
        ok: true as const,
        data: {
          phase: status.phase,
          remaining_min: Math.ceil(status.remainingSec / 60),
        },
      };
    },
  };
}
