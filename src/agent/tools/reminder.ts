/**
 * reminder_* 工具 —— 自然语言提醒的 Agent 通道（learning/08 §5）。
 *
 * 时间解析责任链（08 §5.2）：模型凭上下文注入的当前时间把"明早九点"解析为
 * **带时区绝对时间 ISO 8601**；本组工具做应用侧硬校验（可解析/非过去/≤30 天），
 * 失败信息面向模型（它会向用户澄清——01 §4.3 自愈机制）。
 * "半小时后"由模型算，工具校验宽松合理性（防模型分钟级加法错，08 §5.2）。
 */

import type { ToolDefinition } from "./registry";
import type { ReminderStore } from "@/services/reminders";

/** 距今上限：30 天（learning/08 §5.2；周期提醒 v1 不支持，模型引导降级） */
const MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
/** 允许的"过去"容忍度：60 秒（模型算当前时间可能有秒级偏差） */
const PAST_TOLERANCE_MS = 60_000;

/**
 * 解析并校验 fire_at → epoch ms。返回 { ms } 或 { error }（error 文案面向模型）。
 * 无时区的 ISO 串按本地时区解释（Date.parse 标准行为）。
 */
export function parseFireAt(input: string, now = new Date()): { ms: number } | { error: string } {
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) {
    return { error: `无法解析时间"${input}"，请确认格式（如 2026-11-04T09:00:00+08:00），必要时向用户确认具体时间` };
  }
  if (ms < now.getTime() - PAST_TOLERANCE_MS) {
    return { error: "该时间已经过去了，请确认用户指的是明天/下周，重新解析后再调用" };
  }
  if (ms > now.getTime() + MAX_HORIZON_MS) {
    return { error: "提醒时间超出支持范围（30 天内）。建议用户改用 add_todo 记录，或指定更近的时间" };
  }
  return { ms };
}

export function createReminderTool(store: ReminderStore): ToolDefinition<{ text: string; fire_at: string }> {
  return {
    name: "create_reminder",
    description:
      "创建一次性定时提醒，到点弹系统通知。用户说'X 点提醒我…'/'半小时后提醒我…'时使用。" +
      "fire_at 是**绝对时间**：先看对话中的『当前时间』锚点，把用户的相对表述解析为" +
      "ISO 8601（无时区则按本地时区）。'半小时后'请自行换算为绝对时刻。" +
      "如果用户要的是周期提醒（每天/每周），v1 暂不支持——如实说明并建议先建今天的。" +
      "区别：'加个待办'用 add_todo（清单），'到点提醒我'才用本工具。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "提醒内容，简洁（如：交周报）" },
        fire_at: { type: "string", description: "绝对时间 ISO 8601，如 2026-11-04T09:00:00+08:00" },
      },
      required: ["text", "fire_at"],
    },
    risk: "write",
    async execute(args) {
      const parsed = parseFireAt(args.fire_at);
      if ("error" in parsed) return { ok: false as const, error: parsed.error };
      const reminder = await store.create(args.text.trim(), parsed.ms);
      return {
        ok: true as const,
        data: {
          id: reminder.id,
          text: reminder.text,
          fire_at_local: new Date(reminder.fireAt).toLocaleString("zh-CN"),
          message: "提醒已设置，到点会弹系统通知",
        },
      };
    },
  };
}

export function cancelReminderTool(store: ReminderStore): ToolDefinition<{ id: number }> {
  return {
    name: "cancel_reminder",
    description: "取消一条未触发的提醒。id 来自 list_reminders；不确定时先查询。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "提醒 id（来自 list_reminders）" },
      },
      required: ["id"],
    },
    risk: "destructive",
    async execute(args) {
      const cancelled = await store.cancel(args.id);
      if (!cancelled) return { ok: false as const, error: `找不到待触发提醒 id=${args.id}，可先用 list_reminders 查询` };
      return { ok: true as const, data: { cancelled: { id: cancelled.id, text: cancelled.text }, message: "已取消" } };
    },
  };
}

export function listRemindersTool(store: ReminderStore): ToolDefinition<Record<string, never>> {
  return {
    name: "list_reminders",
    description: "列出所有待触发的提醒（按时间升序）。",
    parameters: { type: "object", properties: {} },
    risk: "read",
    async execute() {
      const reminders = await store.listActive();
      return {
        ok: true as const,
        data: {
          count: reminders.length,
          reminders: reminders.map(r => ({
            id: r.id,
            text: r.text,
            fire_at_local: new Date(r.fireAt).toLocaleString("zh-CN"),
          })),
        },
      };
    },
  };
}
