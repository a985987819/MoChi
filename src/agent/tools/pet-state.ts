/**
 * set_pet_state 工具 —— 宠物情绪联动（roadmap v0.4.0 验收：被夸→happy）。
 *
 * 枚举只含 **happy / sad** 两个情绪状态——这是 learning/08 §2 对 learning/01 §4.5 的
 * 精化：`thinking`/`talking` 由应用从 AgentEvent 映射（模型不该自导自演），
 * `alert`/`focus`/`break`/`sleep` 是系统事件专用（应用裁决，Agent 无权设置）。
 * 工具内零逻辑：经 `state://set-mood` 事件跨窗口遥控宠物窗的 PetStateManager
 * （宠物窗宿主，聊天窗只是发令方——learning/06 §2.3 事件方向约定）。
 */

import { sendStateEvent, STATE_EVENTS } from "@/shared/events";
import type { ToolDefinition } from "./registry";

export function setPetStateTool(): ToolDefinition<{ state: "happy" | "sad"; duration_sec?: number }> {
  return {
    name: "set_pet_state",
    description:
      "调整你（桌宠）的表情状态。在给出文字回复后按需调用：被夸奖/好事→happy；被批评/委屈→sad。" +
      "情绪平稳时不要调用。每次调用会覆盖上一个情绪状态。",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["happy", "sad"], description: "目标情绪" },
        duration_sec: {
          type: "number",
          description: "持续秒数，可选。缺省由应用随机（6~10 秒）自动回落",
        },
      },
      required: ["state"],
    },
    risk: "write",
    async execute(args) {
      await sendStateEvent(STATE_EVENTS.setMood, {
        state: args.state,
        ...(args.duration_sec != null ? { durationSec: args.duration_sec } : {}),
      });
      return { ok: true as const, data: { state: args.state, message: "表情已切换" } };
    },
  };
}
