import { MochiPlaceholder } from "@/shared/components/MochiPlaceholder";
import "./alert.css";

/**
 * 提醒弹窗（alert）—— v0.1.0 骨架版。
 *
 * v0.7.0 接入站立提醒：TimerService 显示本窗口，用户点击弹窗即重置计时。
 * 窗口特性：无边框、置顶、跳过任务栏，由 Rust 侧控制显示时机与位置。
 */
export function AlertApp() {
  return (
    <main className="alert-shell">
      <div className="alert-card">
        <MochiPlaceholder size={64} />
        <h1>该站起来啦</h1>
        <p>点击我重置计时 · v0.7.0 启用</p>
      </div>
    </main>
  );
}
