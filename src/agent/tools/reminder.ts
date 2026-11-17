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
import { parseRepeat, REPEAT_VALUES } from "@/services/recurrence";

/** 距今上限：30 天（learning/08 §5.2；周期提醒只需首次落在窗口内，续期由调度器负责） */
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

export function createReminderTool(store: ReminderStore): ToolDefinition<{
  text: string;
  fire_at: string;
  repeat?: string;
}> {
  return {
    name: "create_reminder",
    description:
      "创建定时提醒，到点弹系统通知。用户说'X 点提醒我…'/'半小时后提醒我…'时使用。" +
      "fire_at 是**绝对时间**：先看对话中的『当前时间』锚点，把用户的相对表述解析为" +
      "ISO 8601（无时区则按本地时区）。'半小时后'请自行换算为绝对时刻。" +
      "**周期提醒**（v0.13.0 起支持）：用户说'每天/工作日/每周'时传 repeat=" +
      "daily / weekdays / weekly，fire_at 传**第一次**触发的时刻（例如用户说'每天九点'，" +
      "当前已过九点就传明天九点）。周期提醒的后续治理（v0.20.0）：用户说'下次别响/明天跳过'" +
      "用 skip_reminder；说'别再提醒了/取消整个'用 cancel_reminder(all=true)。" +
      "区别：'加个待办'用 add_todo（清单），'到点提醒我'才用本工具。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "提醒内容，简洁（如：交周报）" },
        fire_at: { type: "string", description: "首次触发的绝对时间 ISO 8601，如 2026-11-04T09:00:00+08:00" },
        repeat: {
          type: "string",
          enum: [...REPEAT_VALUES],
          description: "重复规则：none（默认，一次性）/ daily 每天 / weekdays 工作日 / weekly 每周同一天",
        },
      },
      required: ["text", "fire_at"],
    },
    risk: "write",
    async execute(args) {
      const parsed = parseFireAt(args.fire_at);
      if ("error" in parsed) return { ok: false as const, error: parsed.error };
      const repeat = parseRepeat(args.repeat);
      const reminder = await store.create(args.text.trim(), parsed.ms, repeat);
      return {
        ok: true as const,
        data: {
          id: reminder.id,
          text: reminder.text,
          fire_at_local: new Date(reminder.fireAt).toLocaleString("zh-CN"),
          repeat: reminder.repeat,
          message: repeat === "none" ? "提醒已设置，到点会弹系统通知" : "周期提醒已设置，每次触发后自动排下一次",
        },
      };
    },
  };
}

export function cancelReminderTool(store: ReminderStore): ToolDefinition<{ id: number; all?: boolean }> {
  return {
    name: "cancel_reminder",
    description:
      "取消未触发的提醒。id 来自 list_reminders；不确定时先查询。" +
      "**周期提醒的整串取消**（v0.20.0）：用户说'别再提醒了/把整个都取消'时传 all=true——" +
      "按同一 series_id 批量取消该串的全部待触发行；只取消单次用默认（all 不传）。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "提醒 id（来自 list_reminders）" },
        all: { type: "boolean", description: "true = 取消整串周期提醒（同一 series 的全部待触发行）；缺省只取消这一条" },
      },
      required: ["id"],
    },
    risk: "destructive",
    async execute(args) {
      if (args.all === true) {
        const active = await store.listActive();
        const target = active.find(r => r.id === args.id);
        if (!target) {
          return { ok: false as const, error: `找不到待触发提醒 id=${args.id}，可先用 list_reminders 查询` };
        }
        if (!target.seriesId) {
          return {
            ok: false as const,
            error: `提醒 id=${args.id} 是一次性提醒（没有周期串），直接调用 cancel_reminder(id) 不带 all 即可`,
          };
        }
        const cancelled = await store.cancelSeries(target.seriesId);
        return {
          ok: true as const,
          data: {
            cancelled_count: cancelled.length,
            texts: cancelled.map(r => r.text),
            message: `已取消整串周期提醒（${cancelled.length} 条，含未来所有待触发行）`,
          },
        };
      }
      const cancelled = await store.cancel(args.id);
      if (!cancelled) return { ok: false as const, error: `找不到待触发提醒 id=${args.id}，可先用 list_reminders 查询` };
      return { ok: true as const, data: { cancelled: { id: cancelled.id, text: cancelled.text }, message: "已取消" } };
    },
  };
}

/**
 * 跳过一次（v0.20.0）：与 cancel 的语义分界写给模型——"周末不想被吵"是跳过
 * （周期还在），"别再提醒了"是取消整串。一次性提醒没有"下一次"可跳，错误信息
 * 引导模型改用 cancel。
 */
export function skipReminderTool(store: ReminderStore): ToolDefinition<{ id: number }> {
  return {
    name: "skip_reminder",
    description:
      "跳过周期提醒的**下一次**触发（用户说'明天别响/下次跳过/周末不想被吵'时使用）。" +
      "周期照常继续（下一次之后恢复正常）。仅对 repeat != none 的提醒有效；" +
      "想彻底不再提醒用 cancel_reminder。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "提醒 id（来自 list_reminders）" },
      },
      required: ["id"],
    },
    risk: "write",
    async execute(args) {
      const skipped = await store.skipNext(args.id);
      if (!skipped) {
        return {
          ok: false as const,
          error: `无法跳过 id=${args.id}：它可能是一次性提醒（跳过=取消，请用 cancel_reminder）、已被取消/触发，或已处于跳过状态`,
        };
      }
      return {
        ok: true as const,
        data: {
          skipped: { id: skipped.id, text: skipped.text, fire_at_local: new Date(skipped.fireAt).toLocaleString("zh-CN") },
          message: "下一次将静默跳过，之后照常提醒",
        },
      };
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
            repeat: r.repeat,
            series: r.seriesId != null,
            skip_next: r.skip === true,
          })),
        },
      };
    },
  };
}
