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
 * 纯函数、零依赖：与 listTools() 的全量断言见 __tests__/tool-labels.test.ts
 * （facade 依赖 tauri 进不了 node 测试，断言以工具源码为事实源做机械扫描）。
 */

/** 工具名 → 用户看到的动作文案（与 src/agent/tools/ 注册名一一对应） */
export const TOOL_LABELS: Record<string, string> = {
  add_todo: "已加入待办",
  list_todos: "翻了翻你的待办",
  complete_todo: "已勾掉一条待办",
  delete_todo: "已删除一条待办",
  search_food: "查了热量表",
  search_health_advice: "翻了翻权威健康指南",
  create_reminder: "设好了提醒",
  cancel_reminder: "取消了提醒",
  list_reminders: "看了你的提醒",
  start_pomodoro: "开始专注",
  stop_pomodoro: "停止了专注",
  get_pomodoro_status: "看了下番茄钟",
  remember: "记住了这件事",
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
    const label = TOOL_LABELS[s.name];
    if (label === undefined) {
      // 漏译兜底：显示原始名（全等断言保证这里平时不会走到）
      parts.push(s.ok ? s.name : `${s.name}没成功`);
    } else {
      parts.push(s.ok ? label : `「${label}」没成功`);
    }
  }
  return parts.join(" · ");
}
