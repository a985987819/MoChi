/**
 * Mochi 占位形象（内置 SVG 兜底）。
 *
 * v0.1.0 宠物窗静态显示它；v0.2.0 引入「素材命名约定 + 目录扫描」后，
 * 该组件降级为回退链的最后一环：用户目录没有图、内置素材也没有图时才显示，
 * 保证任何状态下宠物窗都不白屏。
 *
 * 造型：一颗软糯的白色麻薯团子（椭圆身 + 腮红 + 高光眼），
 * 纯 SVG 内联渲染，无外部资源依赖。
 */
export function MochiPlaceholder({ size = 168 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      role="img"
      aria-label="Mochi 占位形象"
      style={{ display: "block", filter: "drop-shadow(0 10px 14px rgba(190, 120, 140, 0.25))" }}
    >
      <defs>
        <radialGradient id="mochi-body" cx="50%" cy="32%" r="78%">
          <stop offset="0%" stopColor="#fffcf9" />
          <stop offset="72%" stopColor="#fff3f0" />
          <stop offset="100%" stopColor="#ffe4ec" />
        </radialGradient>
      </defs>

      {/* 身体：上圆下宽的团子形（用两条对称的三次贝塞尔曲线画胖乎乎轮廓） */}
      <path
        d="M100 16 C 150 16 178 56 176 102 C 174 150 146 182 100 182 C 54 182 26 150 24 102 C 22 56 50 16 100 16 Z"
        fill="url(#mochi-body)"
      />

      {/* 腮红 */}
      <ellipse cx="60" cy="114" rx="15" ry="9.5" fill="#ffc4d0" opacity="0.85" />
      <ellipse cx="140" cy="114" rx="15" ry="9.5" fill="#ffc4d0" opacity="0.85" />

      {/* 眼睛：椭圆眼 + 白色高光点 */}
      <ellipse cx="71" cy="94" rx="7.5" ry="9.5" fill="#4a3f3f" />
      <ellipse cx="129" cy="94" rx="7.5" ry="9.5" fill="#4a3f3f" />
      <circle cx="73.8" cy="90.5" r="2.6" fill="#ffffff" />
      <circle cx="131.8" cy="90.5" r="2.6" fill="#ffffff" />

      {/* 嘴：微笑弧线 */}
      <path
        d="M90 112 Q 100 122 110 112"
        stroke="#4a3f3f"
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
