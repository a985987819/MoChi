/**
 * pomodoro_* 工具 —— 番茄钟的 Agent 通道（learning/07 §4.3 双入口的 Agent 侧；
 * UI 通道在 PomodoroTab）。规格：docs/learning/08-timers-reminders-presence.md §4.4。
 *
 * PomodoroService 驻留宠物窗（常宿主），本组工具经 state://pomodoro-start/stop
 * 跨窗口遥控；启停和查询都等待宠物窗回执，不以缓存推断执行成功。
 * 参数边界校验在工具层（5~90 分钟），越界返回 ok:false 让模型向用户澄清。
 */

import type { ToolDefinition } from "./registry";
import type { PomodoroControl } from "@/services/pomodoro-control";

/** 参数先校验，执行结果仍以宿主回执为准，防止两次调用并发穿过缓存。 */
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
      const result = await ctl.start(args.minutes);
      if (!result.ok) return result;
      return { ok: true as const, data: { message: `番茄钟已开始（${result.data.remainingSec / 60} 分钟）` } };
    },
  };
}

/** 等待停止完成后再向模型确认；通信失败必须保留错误。 */
export function stopPomodoroTool(ctl: PomodoroControl): ToolDefinition<Record<string, never>> {
  return {
    name: "stop_pomodoro",
    description: "停止当前番茄钟（用户说'停下番茄钟'/'不专注了'时使用）。",
    parameters: { type: "object", properties: {} },
    risk: "write",
    async execute() {
      const result = await ctl.stop();
      if (!result.ok) return result;
      return { ok: true as const, data: { message: "番茄钟已停止" } };
    },
  };
}

/** 首次打开聊天窗也能查询，未收到过广播不等于番茄钟空闲。 */
export function pomodoroStatusTool(ctl: PomodoroControl): ToolDefinition<Record<string, never>> {
  return {
    name: "get_pomodoro_status",
    description: "查询番茄钟当前状态（阶段与剩余时间）。",
    parameters: { type: "object", properties: {} },
    risk: "read",
    async execute() {
      const result = await ctl.status();
      if (!result.ok) return result;
      const status = result.data;
      if (status.phase === "idle") {
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
