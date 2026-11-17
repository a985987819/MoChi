import { createRoot } from "react-dom/client";
import { PetApp } from "./PetApp";
import { petState } from "@/services/pet-state";
import { presenceService } from "@/services/presence";
import { standupService, pomodoroService } from "@/services/timers";
import { reminderScheduler } from "@/services/reminders";
import { listen } from "@tauri-apps/api/event";
import { loadSettings, type AppSettings } from "@/services/settings";
import { registerNotificationTapRouting, warmupNotificationPermission } from "@/services/notifications";
import { sendStateEvent, sendUIEvent, STATE_EVENTS, UI_EVENTS } from "@/shared/events";
import { hostServices } from "@/services/host-services";
import { startSystemEvents } from "@/services/system-events";
import { configureSound, playAlert } from "@/services/sound";
import { subscribeHeartbeat } from "@/services/heartbeat";
import { installGlobalErrorLogging } from "@/services/log";
import { installThemeWatcher } from "@/shared/theme";
import "@/shared/theme.css";

// 全局异常落盘（v0.16.0）：未捕获错误/拒绝进日志文件（release 无控制台）
installGlobalErrorLogging("pet");

// 主题监听（v0.18.0）：设置/系统深浅变化时切换本窗口的 data-theme
installThemeWatcher();

// 跨窗口遥控监听（state://set-mood 等）只装一次：宠物窗是宠物状态的宿主窗口
void petState.installRemoteListeners().catch(() => undefined);

// 通知权限预热（P0-03）：macOS 首次会弹系统询问，集中在启动时做——
// 到点提醒的瞬间才弹授权框会打断用户；Windows 恒已授权，预热幂等
void warmupNotificationPermission();

// 通知点击路由（P1-02 / v0.14.0）：点系统通知 → 聚焦聊天窗并直达对应 Tab。
// 必须在通知发出**之前**注册——插件只对监听器存在期间发出的通知回报点击。
void registerNotificationTapRouting();

// 常驻服务（v0.7.0，learning/08）：宠物窗是应用生命周期最长的宿主窗口
// （关闭=隐藏、进程常驻托盘），计时器/在场检测/提醒调度都驻留这里。
// 各服务经 hostServices 独立监督启动：设置/数据库暂时失败不拖垮其他功能，
// 初始化失败每 5 秒重试；HMR 退出统一释放，避免多套旧监听并存。
void presenceService.start(); // 在场检测 → sleep 状态 + 提醒推迟的依据
/**
 * 系统事件翻译器（v0.11.0）：把原生节拍的 `{ gap_ms, locked }` 翻成
 * `state://system-resumed` / `state://session-lock-changed` 两个广播。
 * 用监督器托管：监听注册失败每 5 秒重试，热更新时释放（否则一次节拍会喂给多套旧监听）。
 */
let disposeSystemEvents: (() => void) | null = null;
const systemEventsService = {
  start: async () => {
    disposeSystemEvents = await startSystemEvents();
  },
  dispose: () => {
    disposeSystemEvents?.();
    disposeSystemEvents = null;
  },
};

const hosted = hostServices([
  standupService,
  pomodoroService,
  systemEventsService,
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
 * 启动时的设置读取，做三件事（P1-13/14/15 + v0.9.0 首启引导）：
 * ① 全局快捷键 / 开机自动打开（自启）/ 游戏模式 / 宠物大小按设置应用——设置页
 *    切换走同样的 state:// 事件，Rust 只执行系统级变更。**开机自启在启动时重放
 *    一次是自愈**：重装或换安装目录后，注册表里旧的 exe 路径会被刷新成当前路径；
 * ② 首启引导入口：「双击宠物打开聊天」是个没有暗示的隐藏手势，新用户装完只看
 *    得到一个静止的团子——首启由宠物窗延迟 1.2s 把聊天窗叫出来展示 WelcomeGuide
 *    （先让麻薯在右下角建立"会动的小东西"的第一印象，再弹向导）；
 * ③ 兜底重放（v0.9.1，见下方 bootSync 注释）——打包版首启存在"脚本早于 Rust
 *    监听注册"的时序，靠原生节拍补一次。
 * 读失败静默跳过：监督器负责服务重试，这里是纯 UI 预设，下个设置变更会补上。
 */

/** 四项系统级设置的重放（幂等：同值重复应用安全，见各 Rust 处理函数） */
function syncStartupSettings(settings: AppSettings): void {
  void sendStateEvent(STATE_EVENTS.shortcutChanged, { enabled: settings.shortcutEnabled }).catch(() => undefined);
  void sendStateEvent(STATE_EVENTS.autostartChanged, { enabled: settings.autostartEnabled }).catch(() => undefined);
  void sendStateEvent(STATE_EVENTS.gameModeChanged, { enabled: settings.gameModeEnabled }).catch(() => undefined);
  void sendStateEvent(STATE_EVENTS.petScaleChanged, { scale: settings.petScale }).catch(() => undefined);
  // 声音（v0.12.0）：开关/音量/免打扰一起下发；关掉开关时 sound 模块会释放已建的 AudioContext。
  // 放在这里而不是各个播放点：播放点只关心"响哪种声音"，不关心用户配置。
  configureSound({
    enabled: settings.soundEnabled,
    volumePercent: settings.soundVolume,
    quietHours: {
      enabled: settings.quietHoursEnabled,
      start: settings.quietStartHour,
      end: settings.quietEndHour,
    },
  });
}

/** 首启引导只叫一次（首次读取与兜底重放都可能走到这里） */
let onboardingOpened = false;
function maybeOpenOnboarding(settings: AppSettings): void {
  if (onboardingOpened || settings.onboardingDone) return;
  onboardingOpened = true;
  window.setTimeout(() => void sendUIEvent(UI_EVENTS.openChat).catch(() => undefined), 1200);
}

void loadSettings().then(settings => {
  syncStartupSettings(settings);
  maybeOpenOnboarding(settings);
}).catch(() => undefined);

/**
 * 设置变更（v0.12.0）：设置页拨动声音开关/音量后立刻生效，不用重启。
 * 只重放"随设置变化的东西"（快捷键/自启/游戏模式/缩放/声音）——都是幂等的。
 */
void listen(STATE_EVENTS.settingsChanged, () => {
  void loadSettings().then(syncStartupSettings).catch(() => undefined);
}).catch(() => undefined);

/**
 * 提醒音（v0.12.0）：监听原生提醒队列的队头变化，**同一个 id 只响一次**。
 * 队列里换下一条时 id 会变，所以"连续多条提醒"会各响一声，而重试/重播不会重复响。
 */
let lastAlertSoundId: string | null = null;
void listen<{ id: string; kind: string } | null>(STATE_EVENTS.appAlertChanged, event => {
  const alert = event.payload;
  if (!alert || alert.id === lastAlertSoundId) return;
  lastAlertSoundId = alert.id;
  playAlert(alert.kind === "standup" || alert.kind === "pomodoro" ? alert.kind : "reminder");
}).catch(() => undefined);

/**
 * 首启兜底重放（v0.9.1 实测修复）。
 *
 * 现象：打包版**首次**启动时「开机自动打开」不生效（系统启动项没写入），用调试
 * 端口手动重载宠物页立刻正常；开发模式（页面由 vite 提供）也一直正常。
 *
 * 原因：webview → Rust 的单向事件在启动瞬间有竞态。前端 `emit()` 发出的事件如果
 * 早于 Rust `setup_ui_event_listeners` 注册监听，就会被**直接丢弃且不报错**
 * ——`.catch()` 也捕获不到（invoke 本身是成功的）。内嵌资源比 vite 加载快得多，
 * 于是只有"打包版 + 首启"这一种组合会踩中；同一段代码里 v0.9.0 的快捷键、宠物
 * 大小其实有同样风险（只是没人注意到首次启动没生效）。
 *
 * 为什么不改成命令（invoke）：invoke 有请求/响应，天然不会丢，但那要把四项设置
 * 各写一个命令，等于把"事件驱动"的通信协议拆成两套。这里沿用既有协议，用**原生
 * 节拍**当"两侧都就绪"的确定信号——它由 Rust 在 setup 之后每秒发给宠物窗一次，
 * 第一拍到达时再重放一次即可（重放幂等，正常路径下等于把同值再设一遍）。
 */
let bootSyncRetried = false;
void listen(STATE_EVENTS.nativeTick, () => {
  if (bootSyncRetried) return;
  bootSyncRetried = true;
  void loadSettings()
    .then(settings => {
      syncStartupSettings(settings);
      maybeOpenOnboarding(settings);
    })
    .catch(() => undefined);
}).catch(() => undefined);

createRoot(document.getElementById("root")!).render(<PetApp />);
