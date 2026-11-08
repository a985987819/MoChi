import "./loading.css";

/**
 * 加载指示 —— v0.9.0 体验扩展。
 *
 * 为什么共享一个组件而不是各处自己写 spinner：
 * 1. 各异步阶段（设置/历史/待办/记忆）的加载观感必须一致——"看起来像同一个应用"；
 * 2. reduced-motion 与动画曲线只在这一处调，改一处全局生效；
 * 3. 教学上把「加载是 UI 状态不是异常」固化成组件契约：调用方给 label，
 *    失败态由调用方自己渲染（错误是业务信息，不该藏在 spinner 里）。
 *
 * skeleton 是它的姐妹样式（loading.css 的 .skeleton）：已知形状的面板
 * （如设置页的行）用骨架行占位，比单点 spinner 更少布局跳动。
 */

/** 旋转圈 + 可选文案；容器自带最小高度，避免加载完成时高度突变 */
export function Loading({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading__spinner" aria-hidden="true" />
      <span className="loading__label">{label}</span>
    </div>
  );
}

/** 骨架行组：widths 给每行的相对宽度（0~1），模拟真实内容的长度节奏 */
export function SkeletonLines({ widths = [0.7, 0.92, 0.55], rows = 3 }: { widths?: number[]; rows?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton__line" style={{ width: `${Math.round((widths[i % widths.length] ?? 0.7) * 100)}%` }} />
      ))}
    </div>
  );
}
