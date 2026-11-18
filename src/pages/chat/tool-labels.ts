/**
 * 工具轨迹文案（v0.9.0 P1-06）——把技术黑话翻译成人话。
 *
 * 旧渲染：`🔧 todo_add ✓ · set_pet_state ✓`——用户看到的是内部枚举与勾叉。
 * 新渲染：`🔧 已加入待办 · 记住了这件事`。
 *
 * 规则（施工单 P1-06）：
 * - set_pet_state 是情绪副作用（Agent 的表情管理），不是用户要办的事，**不进轨迹**；
 * - 失败显示「X 没成功」（「」引出动作名，避免"已加入待办没成功"的语病观感）；
 * - 未知工具（未来新增但漏译）兜底显示原始名——单测的全等断言会让漏译在
 *   CI 就暴露，兜底只是双保险。
 *
 * v0.21.0 i18n：值改为 **i18n key**（MessageKey），文案在 zh-CN.ts / en.ts——
 * t() 在调用时读当前 locale（模块级状态），所以本模块在 React 外也正确。
 * 与 listTools() 的全量断言见 __tests__/tool-labels.test.ts（facade 依赖 tauri
 * 进不了 node 测试，断言以工具源码为事实源做机械扫描）。
 */

import { t } from "@/shared/i18n/core";
import type { MessageKey } from "@/shared/i18n/zh-CN";

/** 工具名 → 动作文案的 i18n key（与 src/agent/tools/ 注册名一一对应） */
export const TOOL_LABELS: Record<string, MessageKey | ""> = {
  add_todo: "tool.addTodo",
  list_todos: "tool.listTodos",
  complete_todo: "tool.completeTodo",
  delete_todo: "tool.deleteTodo",
  search_food: "tool.searchFood",
  search_health_advice: "tool.searchHealthAdvice",
  create_reminder: "tool.createReminder",
  cancel_reminder: "tool.cancelReminder",
  skip_reminder: "tool.skipReminder",
  list_reminders: "tool.listReminders",
  start_pomodoro: "tool.startPomodoro",
  stop_pomodoro: "tool.stopPomodoro",
  get_pomodoro_status: "tool.getPomodoroStatus",
  remember: "tool.remember",
  open_url: "tool.openUrl",
  open_data_folder: "tool.openDataFolder",
  set_pet_state: "", // 情绪副作用：不展示（见 formatToolTrace 的过滤）
};

export interface ToolSummary {
  name: string;
  ok: boolean;
}

/**
 * 一轮 step 的工具轨迹 → 一行用户文案；无可展示项（如只有 set_pet_state）
 * 返回空串（调用方跳过这条 note，不渲染空行）。
 */
export function formatToolTrace(summaries: ToolSummary[]): string {
  const parts: string[] = [];
  for (const s of summaries) {
    if (s.name === "set_pet_state") continue; // 内部动作，不进用户轨迹
    const key = TOOL_LABELS[s.name];
    if (key === undefined) {
      // 漏译兜底：显示原始名（全等断言保证这里平时不会走到）
      parts.push(s.ok ? s.name : t("tool.failRaw", { name: s.name }));
    } else if (key !== "") {
      parts.push(s.ok ? t(key) : t("tool.fail", { label: t(key) }));
    }
  }
  return parts.join(" · ");
}
