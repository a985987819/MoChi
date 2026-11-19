/**
 * 窗口拖拽助手（v0.23.1）—— 自绘标题栏的"整行可抓"拖拽。
 *
 * # 为什么不用 data-tauri-drag-region
 *
 * 该属性只对**携带它的元素本身**生效（Tauri 注入的监听检查 event.target），
 * 标题栏被 Tabs / 关闭钮铺满后，可抓区域只剩标题文字与缝隙——太不方便。
 * 手动 mousedown + startDragging() 可以自己定义"交互控件除外"的排除规则，
 * 让整条标题栏（含 Tab 两侧空隙）都能抓。
 *
 * # 权限
 *
 * `getCurrentWindow().startDragging()` 属 `core:window:allow-start-dragging`。
 * **它不在 core:window:default 里**（v0.29.1 修正旧注释：默认集只含查询类命令），
 * 必须在 `capabilities/default.json` 显式授权，否则 Promise 被 .catch 静默吞掉，
 * 表现为"标题栏按了没反应"。同理，聊天窗缩放热区需要
 * `core:window:allow-start-resize-dragging`。
 *
 * # 排除规则
 *
 * mousedown 落在**交互控件**（button/input/select/textarea/a/label）上时不拖拽，
 * 让点击行为保持原样；其余区域按下即进入系统移动循环（松手或 Esc 退出）。
 * 右键/中键不响应——拖拽是左键手势。
 */

import { getCurrentWindow } from "@tauri-apps/api/window";

/** 交互控件判定：拖拽不抢它们的点击 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("button, input, select, textarea, a, label, [data-no-drag]") !== null
  );
}

/**
 * mousedown 事件处理器：左键按下且不在交互控件上时，交系统开始拖动窗口。
 * 用法：`<header onMouseDown={dragWindow}>`；聊天窗空态背景也用同一个处理器。
 * startDragging 失败（权限异常等）静默——拖不动不该变成一次报错。
 */
export function dragWindow(e: { button: number; target: EventTarget | null }): void {
  if (e.button !== 0) return;
  if (isInteractiveTarget(e.target)) return;
  void getCurrentWindow()
    .startDragging()
    .catch(() => undefined);
}
