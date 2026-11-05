/** 用真实布局尺寸夹紧菜单，展开演示区后也不把退出按钮推到宠物窗口之外。 */
export function clampMenuPosition(
  x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number,
): { left: number; top: number } {
  return {
    left: Math.max(4, Math.min(x, viewportWidth - width - 4)),
    top: Math.max(4, Math.min(y, viewportHeight - height - 4)),
  };
}
