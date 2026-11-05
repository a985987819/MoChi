import { createRoot } from "react-dom/client";
import { PetApp } from "./PetApp";
import { petState } from "@/services/pet-state";
import { presenceService } from "@/services/presence";
import { standupService, pomodoroService } from "@/services/timers";
import { reminderScheduler } from "@/services/reminders";
import { loadSettings } from "@/services/settings";
import { warmupNotificationPermission } from "@/services/notifications";
import { sendStateEvent, sendUIEvent, STATE_EVENTS, UI_EVENTS } from "@/shared/events";
import { hostServices } from "@/services/host-services";
import { subscribeHeartbeat } from "@/services/heartbeat";

// 跨窗口遥控监听（state://set-mood 等）只装一次：宠物窗是宠物状态的宿主窗口
void petState.installRemoteListeners().catch(() => undefined);

// 通知权限预热（P0-03）：macOS 首次会弹系统询问，集中在启动时做——
// 到点提醒的瞬间才弹授权框会打断用户；Windows 恒已授权，预热幂等
void warmupNotificationPermission();

// 常驻服务（v0.7.0，learning/08）：宠物窗是应用生命周期最长的宿主窗口
// （关闭=隐藏、进程常驻托盘），计时器/在场检测/提醒调度都驻留这里。
// 各服务经 hostServices 独立监督启动：设置/数据库暂时失败不拖垮其他功能，
// 初始化失败每 5 秒重试；HMR 退出统一释放，避免多套旧监听并存。
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
 * 启动时的一次设置读取，做三件事（P1-13/14/15 + v0.9.0 首启引导）：
 * ① 全局快捷键 / 开机自启 / 宠物大小按设置应用——设置页切换走同样的 state://
 *    事件，Rust 只执行系统级变更；
 * ② 首启引导入口：「双击宠物打开聊天」是个没有暗示的隐藏手势，新用户装完只看
 *    得到一个静止的团子——首启由宠物窗延迟 1.2s 把聊天窗叫出来展示 WelcomeGuide
 *    （先让麻薯在右下角建立"会动的小东西"的第一印象，再弹向导）。
 * 读失败静默跳过：监督器负责服务重试，这里是纯 UI 预设，下个设置变更会补上。
 */
void loadSettings().then(settings => {
  void sendStateEvent(STATE_EVENTS.shortcutChanged, { enabled: settings.shortcutEnabled }).catch(() => undefined);
  void sendStateEvent(STATE_EVENTS.autostartChanged, { enabled: settings.autostartEnabled }).catch(() => undefined);
  void sendStateEvent(STATE_EVENTS.petScaleChanged, { scale: settings.petScale }).catch(() => undefined);
  if (!settings.onboardingDone) {
    window.setTimeout(() => void sendUIEvent(UI_EVENTS.openChat).catch(() => undefined), 1200);
  }
}).catch(() => undefined);

createRoot(document.getElementById("root")!).render(<PetApp />);
