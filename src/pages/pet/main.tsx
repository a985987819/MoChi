import { createRoot } from "react-dom/client";
import { PetApp } from "./PetApp";
import { petState } from "@/services/pet-state";
import { presenceService } from "@/services/presence";
import { standupService, pomodoroService } from "@/services/timers";
import { reminderScheduler } from "@/services/reminders";
import { loadSettings } from "@/services/settings";
import { warmupNotificationPermission } from "@/services/notifications";
import { sendStateEvent, sendUIEvent, STATE_EVENTS, UI_EVENTS } from "@/shared/events";

// 跨窗口遥控监听（state://set-mood 等）只装一次：宠物窗是宠物状态的宿主窗口
void petState.installRemoteListeners();

// 通知权限预热（P0-03）：macOS 首次会弹系统询问，集中在启动时做——
// 到点提醒的瞬间才弹授权框会打断用户；Windows 恒已授权，预热幂等
void warmupNotificationPermission();

// 全局快捷键（P1-13）：启动时按设置应用开关（键位在 Rust 侧写死）。
// 设置页切换走同一条 state://shortcut-changed 事件
void loadSettings().then(settings => {
  void sendStateEvent(STATE_EVENTS.shortcutChanged, { enabled: settings.shortcutEnabled });
});

// 常驻服务（v0.7.0，learning/08）：宠物窗是应用生命周期最长的宿主窗口
// （关闭=隐藏、进程常驻托盘），计时器/在场检测/提醒调度都驻留这里
void presenceService.start(); // 在场检测 → sleep 状态 + 提醒推迟的依据
void standupService.start(); // 站立提醒（监听 ui://reset-standup / standup-ack）
void pomodoroService.start(); // 番茄钟（监听 state://pomodoro-start/stop）
void reminderScheduler.start(); // 自然语言提醒调度（30s 轮询 SQLite 认领）

/**
 * 首次启动引导的入口（v0.9.0）。
 *
 * 「双击宠物打开聊天」是个没有暗示的隐藏手势，新用户装完只看得到一个静止的团子。
 * 所以首启时由宠物窗主动把聊天窗叫出来，展示 WelcomeGuide。
 * 延迟 1.2s：先让麻薯在右下角出现（用户建立"这是一个会动的小东西"的第一印象），
 * 再弹窗；立刻弹窗会盖住这个第一印象，像被一个向导拦住。
 */
void loadSettings().then(settings => {
  if (settings.onboardingDone) return;
  window.setTimeout(() => void sendUIEvent(UI_EVENTS.openChat), 1200);
});

createRoot(document.getElementById("root")!).render(<PetApp />);
