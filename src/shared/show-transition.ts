/**
 * 窗口唤回时的轻过渡（v0.9.0 手感优化）。
 *
 * Tauri 的 `window.show()` 是瞬时出现——桌宠/聊天窗从托盘或隐藏态唤回时
 * "闪现"一下，视觉上是硬切。窗口内容一直在（关闭=隐藏，不销毁），所以不能
 * 靠 CSS 入场动画（只在挂载时播一次）；本函数用 Web Animations API 直接对
 * 壳层元素播一次「淡入 + 上浮」：不重挂 React 子树、不触发布局，
 * opacity/transform 走合成器线程，不掉帧。
 *
 * 为什么不用 `key={n}` 重挂壳层：聊天窗壳层含整份历史 DOM，重挂等于一次
 * 全量 DOM 重建——恰恰是我们要消除的掉帧源。
 *
 * 触发时机：`document.visibilitychange` 变回 visible 时（Tauri 隐藏窗口会让
 * WebView 的 visibilityState 变 hidden，恢复显示时触发——P1-01 气泡决策已在
 * 依赖同一行为）。
 *
 * 降级路径：不支持 element.animate 的环境（单测/旧 WebView）静默跳过；
 * 系统开启"减少动态效果"时跳过（尊重 prefers-reduced-motion）。
 */
export function playShowTransition(el: HTMLElement | null, distancePx = 8, durationMs = 160): void {
  if (!el || typeof el.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  el.animate(
    [
      { opacity: 0, transform: `translateY(${distancePx}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ],
    { duration: durationMs, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
}

/**
 * 订阅「窗口从隐藏变回可见」：返回解绑函数。
 * 之所以独立成函数：PetApp/ChatApp 都要在唤回时播过渡，visibilitychange 的
 * 语义（Tauri 隐藏/显示窗口会触发）在两处必须一致，测试环境无 document 时静默。
 */
export function onWindowShown(callback: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const handler = () => {
    if (document.visibilityState === "visible") callback();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
