import { createRoot } from "react-dom/client";
import { PetApp } from "./PetApp";
import { petState } from "@/services/pet-state";
import { presenceService } from "@/services/presence";
import { standupService, pomodoroService } from "@/services/timers";
import { reminderScheduler } from "@/services/reminders";
import { loadSettings } from "@/services/settings";
import { sendUIEvent, UI_EVENTS } from "@/shared/events";
import { hostServices } from "@/services/host-services";
import { subscribeHeartbeat } from "@/services/heartbeat";

// 跨窗口遥控监听（state://set-mood 等）只装一次：宠物窗是宠物状态的宿主窗口
void petState.installRemoteListeners().catch(() => undefined);

// 常驻服务（v0.7.0，learning/08）：宠物窗是应用生命周期最长的宿主窗口
// （关闭=隐藏、进程常驻托盘），计时器/在场检测/提醒调度都驻留这里
void presenceService.start(); // 在场检测 → sleep 状态 + 提醒推迟的依据
const hosted = hostServices([
  standupService,
  pomodoroService,
  { start: () => reminderScheduler.start(), dispose: () => reminderScheduler.stop() },
]);
const stateHeartbeat = subscribeHeartbeat(() => petState.refresh());
// 开发热更新也只能保留一套常驻服务，否则一次点击会被多套旧监听消费。
if (import.meta.hot) import.meta.hot.dispose(() => {
  presenceService.stop();
  void hosted.then(dispose => dispose());
  void stateHeartbeat.then(dispose => dispose());
});

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
  window.setTimeout(() => void sendUIEvent(UI_EVENTS.openChat).catch(() => undefined), 1200);
}).catch(() => undefined);

createRoot(document.getElementById("root")!).render(<PetApp />);
