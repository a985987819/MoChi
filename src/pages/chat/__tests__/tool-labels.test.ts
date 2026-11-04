import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatToolTrace, TOOL_LABELS } from "../tool-labels";

/**
 * 工具文案表全量断言（施工单 §7.1：漏译是必然的，要机械保证）。
 *
 * 为什么不 import agentFacade.listTools()：facade 拉起整条 tauri 依赖链
 * （plugin-store/sql/event），vitest 是 node 环境（vite.config.ts 测试纪律）。
 * 所以这里以**工具源码**为事实源：机械扫描 src/agent/tools/*.ts 里所有
 * `name: "xxx"` 注册名，断言与文案表全等——新增工具文件/改名必然进入扫描，
 * 漏译会在 CI 直接红。
 */
const toolsDir = fileURLToPath(new URL("../../../agent/tools", import.meta.url));

function scanRegisteredToolNames(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(toolsDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(`${toolsDir}/${file}`, "utf8");
    for (const m of src.matchAll(/name:\s*"([a-z_]+)"/g)) {
      names.add(m[1]!);
    }
  }
  return [...names].sort();
}

describe("tool-labels 文案表", () => {
  it("与工具注册名全等：每个注册工具都有文案，文案表没有幽灵条目", () => {
    expect(Object.keys(TOOL_LABELS).sort()).toEqual(scanRegisteredToolNames());
  });

  it("formatToolTrace：翻译成人话并用 · 连接", () => {
    expect(formatToolTrace([{ name: "add_todo", ok: true }, { name: "remember", ok: true }])).toBe(
      "已加入待办 · 记住了这件事",
    );
  });

  it("set_pet_state 是内部动作，不进轨迹", () => {
    expect(formatToolTrace([{ name: "set_pet_state", ok: true }])).toBe("");
    expect(
      formatToolTrace([{ name: "set_pet_state", ok: true }, { name: "search_food", ok: true }]),
    ).toBe("查了热量表");
  });

  it("失败显示「X 没成功」", () => {
    expect(formatToolTrace([{ name: "create_reminder", ok: false }])).toBe("「设好了提醒」没成功");
  });

  it("未知工具兜底显示原始名（防新增工具漏译时 UI 空白）", () => {
    expect(formatToolTrace([{ name: "future_tool", ok: true }])).toBe("future_tool");
  });

  it("全部为内部动作时返回空串（调用方跳过该条 note）", () => {
    expect(formatToolTrace([])).toBe("");
  });
});
