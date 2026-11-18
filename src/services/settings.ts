/**
 * 应用设置持久化 —— tauri-plugin-store（KV JSON，落 appData/settings.json）。
 *
 * 安全规范（AGENTS.md）：API Key 只存这里；禁止硬编码、入仓库、入日志。
 * 结构设计：apiKeys/models 按 providerId 分桶——切换提供商不丢各自的配置。
 * v0.7.0 的计时器配置（间隔/番茄钟时长）也进这个文件。
 *
 * 写盘纪律（v0.8.2 + v0.9.0 合并）：
 * - saveSettings 串行执行并**显式等待磁盘落盘**（store.save()），失败如实抛出，
 *   UI 给可重试反馈——「已派发」不等于「已确认」；
 * - 字符级输入（Key/数字框）走 350ms 防抖（settings-debounce，P0-02），
 *   避免每次按键都写盘 + 广播；离散控件直存；
 * - loadSettings 会先等在途保存完成：输入后立刻切窗也能读到最新快照。
 */

import { load } from "@tauri-apps/plugin-store";
import { getPreset } from "@/agent/providers/presets";
import { emit } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";
import { DEFAULT_ADDRESSING, normalizeAddressing, type AddressingPreferences } from "@/shared/addressing";
import { createSettingsSaveQueue } from "./settings-debounce";

export interface AppSettings extends AddressingPreferences {
  /** 当前选中的提供商（presets.id 或 "mock"） */
  providerId: string;
  /** 每提供商独立保存 Key（格式随机，脱敏展示在 UI） */
  apiKeys: Record<string, string>;
  /** 每提供商选定的模型（未选过 = 预设 defaultModel） */
  models: Record<string, string>;
  /** 站立提醒间隔（分钟），learning/08 §4.2；改配置即重置计时 */
  standupIntervalMin: number;
  /** 番茄钟专注时长（分钟） */
  pomodoroFocusMin: number;
  /** 番茄钟休息时长（分钟） */
  pomodoroBreakMin: number;
  /** 系统通知开关（站立提醒/番茄钟/自定义提醒共用） */
  notificationsEnabled: boolean;
  /**
   * 免打扰时段（v0.10.0，**默认关**）：只静默**站立提醒**——它由系统自动生成，
   * 夜里弹出来纯属打扰；用户自己定的提醒与番茄钟照常响（那是明确的指令）。
   * `quietStartHour > quietEndHour` 表示跨午夜（如 22 → 8）；两者相等视为未设置。
   */
  quietHoursEnabled: boolean;
  /** 静默开始的小时（0~23，本地时间） */
  quietStartHour: number;
  /** 静默结束的小时（0~23，本地时间，整点恢复） */
  quietEndHour: number;
  /**
   * 音效开关（v0.12.0，**默认开**）。声音是桌宠"在场感"的一半：点击没反馈音、
   * 提醒只有画面，用户不看屏幕时等于没提醒。关掉后连 `AudioContext` 都不创建。
   */
  soundEnabled: boolean;
  /** 音效音量（0~100，默认 30）：这是**相对**音量，乘在每个音符的基准增益上 */
  soundVolume: number;
  /**
   * 语音朗读开关（v0.15.0 P1-03，**默认关**——比音效保守）。
   * 音效是提示音（预期短、可忽略），TTS 是把整段回复念出来——不问就把每次对话
   * 念出声是打扰，所以默认关，让用户主动开。音源是 Web Speech API 系统语音包
   * （免费、离线、零 Key），云端 TTS 与"离线可用"气质冲突，不做。
   */
  ttsEnabled: boolean;
  /** 朗读语速（0.5~2.0，默认 1）：Web Speech 的 rate 直传 */
  ttsRate: number;
  /** 朗读音色名（系统语音包里的 name；空串 = 自动，zh-CN 优先） */
  ttsVoiceName: string;
  /**
   * 是否已完成首次启动引导（v0.9.0）。
   *
   * 为什么把「引导是否看过」放在设置里而不是 localStorage：
   * 1. 设置本来就随应用走 `tauri-plugin-store`，重装/升级后仍然记得；
   * 2. 引导文案与设置项强相关（第 3 步直接跳设置 Tab），放一起便于版本演进时
   *    用 key 名做迁移（例如将来 onboardingVersion: 2 触发增量引导）；
   * 3. 设置页「重新显示新手引导」= 把它置回 false，零额外状态。
   */
  onboardingDone: boolean;
  /**
   * 全局快捷键开关（v0.9.0 P1-13，默认开）。
   * 键位本身写死在 Rust 侧（Ctrl/Cmd+Shift+M 开聊天窗）——v1 不做自定义键位；
   * 这里只是开关。注册结果（是否被占用）经 state://shortcut-state 回传 UI。
   */
  shortcutEnabled: boolean;
  /**
   * 开机自动打开（v0.9.0 P1-14 引入，v0.9.1 定为现名与现语义，**默认关**——
   * 不默认自启是桌宠软件的底线）。
   * 设置是事实源：Rust 收 state://autostart-changed 后 enable/disable 系统项，
   * 并立刻用 is_enabled() 读回真值经 state://autostart-state 回执（v0.9.1）——
   * 前端不能把"我点开了"当成"系统里真的开了"。启动时宠物窗按本字段应用一次，
   * 顺带自愈：重装/搬家后注册表里的 exe 路径会被这次应用刷新成当前路径。
   */
  autostartEnabled: boolean;
  /**
   * 游戏模式（v0.9.0 自迭代，**默认关**——learning/08 §3 前台嗅探红线的兑现形态）：
   * 开启后 Rust 每秒检查前台窗口是否**全屏覆盖其显示器**（只读窗口矩形几何，
   * 不读应用名/标题/进程——不构成"推断用户在忙什么"），全屏遮挡宠物所在屏时
   * 自动隐藏宠物，退出全屏恢复。默认关是底线：任何形式的"看前台"都需要用户明示。
   */
  gameModeEnabled: boolean;
  /**
   * 宠物大小档位（v0.9.0 P1-15）：0.8 | 1 | 1.2，默认 1。
   * Rust 收 state://pet-scale-changed 后改窗口尺寸（保持右下角锚点 + 屏内
   * clamp）；宠物窗把同值写进 CSS 变量 --pet-scale 缩放形象。
   */
  petScale: number;
  /**
   * 界面语言（v0.19.0 P2-03B）：system 跟随系统（默认）。切语言不重启——
   * 各窗口 installLocaleWatcher 监听 settingsChanged 即时重读。
   */
  locale: LocaleSetting;
  /**
   * 主题模式（v0.18.0 P2-03A）：system 跟随系统（默认）/ light / dark。
   * 每个窗口的 installThemeWatcher 据此写 documentElement[data-theme]，
   * CSS 变量（shared/theme.css）据此切换浅/深。宠物窗背景始终透明——
   * 主题只影响聊天窗/提醒窗/气泡/菜单等 UI 元素，不碰素材。
   */
  themeMode: ThemeMode;
  /**
   * 连通性验证记录（v0.23.2）：「测试连通性」成功时按提供商写入 { 时间, Key 指纹 }。
   * 指纹 = Key 末 4 位 + 长度——只够判断「当前输入的 Key 是否就是验证过的那把」，
   * **不含可还原的 Key 材料**（备份导出同样安全）。Key 一旦修改指纹失配，
   * UI 提示重新测试，旧记录不清除（改回原 Key 恢复"已验证"）。
   */
  verified?: Record<string, { at: number; tail: string; len: number }>;
  /**
   * 主题色（v0.26.0）：六位 hex（含 #），驱动全站 accent 家族（按钮/徽标/提示
   * 底纹等）——派生逻辑见 shared/accent.ts。默认 #ff8fab（奶油粉）= 不覆盖
   * theme.css 静态值。
   */
  accentColor: string;
}

export type ThemeMode = "system" | "light" | "dark";

/** 主题模式的合法取值（normalize 与设置页下拉共用，避免三处各写一份） */
export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"];

/**
 * 界面语言（v0.19.0 P2-03B）：system 跟随系统（默认）/ zh-CN / en。
 * 每个窗口的 installLocaleWatcher 据此切换（运行时生效，不重启）。
 * 首批覆盖：Tab 栏/提醒中心/待办/番茄钟/提醒弹窗/右键菜单——覆盖率见
 * scripts/check-hardcoded-zh.mjs（`pnpm lint:i18n`）。
 */
export type LocaleSetting = "system" | "zh-CN" | "en";

/** 语言设置的合法取值（normalize 白名单；"en" 在 UI 里显示为 English） */
export const LOCALE_SETTINGS: readonly LocaleSetting[] = ["system", "zh-CN", "en"];

const STORE_FILE = "settings.json";
const KEY = "app";

export function defaultSettings(): AppSettings {
  return {
    providerId: "mock",
    apiKeys: {},
    models: {},
    ...DEFAULT_ADDRESSING,
    standupIntervalMin: 60,
    pomodoroFocusMin: 25,
    pomodoroBreakMin: 5,
    notificationsEnabled: true,
    quietHoursEnabled: false,
    quietStartHour: 22,
    quietEndHour: 8,
    soundEnabled: true,
    soundVolume: 30,
    ttsEnabled: false,
    ttsRate: 1,
    ttsVoiceName: "",
    onboardingDone: false,
    shortcutEnabled: true,
    autostartEnabled: false,
    gameModeEnabled: false,
    petScale: 1,
    themeMode: "system",
    locale: "system",
    verified: {},
    accentColor: DEFAULT_ACCENT,
  };
}

/** 默认主题色（v0.26.0：奶油粉）——accentColor 缺省值与「恢复默认」共用 */
export const DEFAULT_ACCENT = "#ff8fab";

/** 宠物大小档位范围（v0.25.0：滑杆连续控制，0.1 一档；原三档 0.8/1/1.2） */
export const PET_SCALE_MIN = 0.2;
export const PET_SCALE_MAX = 2;
export const PET_SCALE_STEP = 0.1;

/** 数值字段夹紧（防设置页输入 0/负数/离谱值） */
const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? Math.round(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** 浮点夹紧（v0.15.0：朗读语速 0.5~2.0 是浮点档位，不能取整） */
const clampFloat = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * 畸形数据归一（导出仅为单测：老配置升级 + 脏 JSON 是真实事故源，施工单 §7.1）。
 * 规则：字段缺省/类型不对 → 用默认值；数值越界 → 夹紧；未知提供商 → 回 mock。
 */
export function normalize(raw: unknown): AppSettings {
  const d = defaultSettings();
  if (typeof raw !== "object" || raw === null) return d;
  const r = raw as Partial<AppSettings>;
  return {
    providerId: typeof r.providerId === "string" && getPreset(r.providerId) ? r.providerId : d.providerId,
    apiKeys: typeof r.apiKeys === "object" && r.apiKeys !== null ? r.apiKeys : d.apiKeys,
    models: typeof r.models === "object" && r.models !== null ? r.models : d.models,
    ...normalizeAddressing(r),
    standupIntervalMin: clampInt(r.standupIntervalMin, 1, 120, d.standupIntervalMin),
    pomodoroFocusMin: clampInt(r.pomodoroFocusMin, 5, 90, d.pomodoroFocusMin),
    pomodoroBreakMin: clampInt(r.pomodoroBreakMin, 1, 30, d.pomodoroBreakMin),
    notificationsEnabled: typeof r.notificationsEnabled === "boolean" ? r.notificationsEnabled : d.notificationsEnabled,
    quietHoursEnabled: typeof r.quietHoursEnabled === "boolean" ? r.quietHoursEnabled : d.quietHoursEnabled,
    // 小时越界即夹紧：0~23 是"整点"语义，越界值（如 24）会让静默时段变成全天或永不生效
    quietStartHour: clampInt(r.quietStartHour, 0, 23, d.quietStartHour),
    quietEndHour: clampInt(r.quietEndHour, 0, 23, d.quietEndHour),
    soundEnabled: typeof r.soundEnabled === "boolean" ? r.soundEnabled : d.soundEnabled,
    soundVolume: clampInt(r.soundVolume, 0, 100, d.soundVolume),
    // v0.15.0：语速浮点夹紧（0.5~2），音色名只认字符串（未知名字由 TTS 层回落自动挑选）
    ttsEnabled: typeof r.ttsEnabled === "boolean" ? r.ttsEnabled : d.ttsEnabled,
    ttsRate: clampFloat(r.ttsRate, 0.5, 2, d.ttsRate),
    ttsVoiceName: typeof r.ttsVoiceName === "string" ? r.ttsVoiceName : d.ttsVoiceName,
    // 老版本 settings.json 没有这个字段：undefined → false（当作没看过引导）。
    // 这正是「升级用户也会看到一次引导」的期望行为——v0.9.0 之前没有引导。
    onboardingDone: typeof r.onboardingDone === "boolean" ? r.onboardingDone : d.onboardingDone,
    shortcutEnabled: typeof r.shortcutEnabled === "boolean" ? r.shortcutEnabled : d.shortcutEnabled,
    autostartEnabled: typeof r.autostartEnabled === "boolean" ? r.autostartEnabled : d.autostartEnabled,
    gameModeEnabled: typeof r.gameModeEnabled === "boolean" ? r.gameModeEnabled : d.gameModeEnabled,
    // v0.25.0：滑杆连续档位——夹紧到 [0.2, 2] 并量化到 0.1（浮点累加误差不会让
    // 档位漂移）；非法值回落 1。窗口尺寸由 Rust 按逻辑像素换算，高分屏自动清晰。
    petScale: (() => {
      const n = typeof r.petScale === "number" && Number.isFinite(r.petScale) ? r.petScale : d.petScale;
      const clamped = Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, n));
      return Math.round(clamped * 10) / 10; // ×10 取整再 ÷10：避免 12 * 0.1 = 1.2000000000000002
    })(),
    // 主题模式白名单（脏值回落 system——跟随系统是唯一不会"错得离谱"的选择）
    themeMode: THEME_MODES.includes(r.themeMode as ThemeMode) ? (r.themeMode as ThemeMode) : d.themeMode,
    // 语言白名单（同上：system 是兜底）
    locale: LOCALE_SETTINGS.includes(r.locale as LocaleSetting) ? (r.locale as LocaleSetting) : d.locale,
    // 验证记录：结构不对整体丢弃（默认 {} = 未验证），指纹字段由使用方比对
    verified:
      typeof r.verified === "object" && r.verified !== null
        ? Object.fromEntries(
            Object.entries(r.verified as Record<string, unknown>).flatMap(([id, v]) => {
              const entry = v as { at?: unknown; tail?: unknown; len?: unknown };
              return typeof entry.at === "number" && typeof entry.tail === "string" && typeof entry.len === "number"
                ? [[id, { at: entry.at, tail: entry.tail, len: entry.len }]]
                : [];
            }),
          )
        : d.verified,
    // 主题色：六位 hex 白名单（非法/缺失回落默认粉）
    accentColor: typeof r.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(r.accentColor)
      ? r.accentColor.toLowerCase()
      : d.accentColor,
  };
}

let storePromise: Promise<Awaited<ReturnType<typeof load>>> | null = null;

/** store 实例单例（plugin-store 的 load 幂等，但收敛到一处便于替换实现） */
function getStore() {
  storePromise ??= load(STORE_FILE, { autoSave: true }).catch(error => {
    storePromise = null; // 暂时不可读不应把所有后续服务启动锁死在同一个 rejected Promise
    throw error;
  });
  return storePromise;
}

export async function loadSettings(): Promise<AppSettings> {
  // 输入后立刻切回聊天时也读取最新快照；保存链路不反向调用 loadSettings，避免自等待。
  await pendingSave.catch(() => undefined);
  const store = await getStore();
  return normalize(await store.get<AppSettings>(KEY));
}

let pendingSave: Promise<void> = Promise.resolve();

/** 串行保存快照并等待磁盘落盘；不能用插件防抖自动保存代替“保存成功”。 */
export function saveSettings(settings: AppSettings): Promise<void> {
  const snapshot = normalize(structuredClone(settings));
  const save = pendingSave.catch(() => undefined).then(async () => {
    const store = await getStore();
    await store.set(KEY, snapshot);
    await store.save();
    // 广播失败不应让已经写入磁盘的设置被误报为保存失败。
    await emit(STATE_EVENTS.settingsChanged, { keys: Object.keys(snapshot) }).catch(() => undefined);
  });
  pendingSave = save;
  return save;
}

// ── 防抖适配层（P0-02）：机制在 ./settings-debounce（纯函数，有单测） ──

const saveQueue = createSettingsSaveQueue(settings => saveSettings(settings));

/**
 * 字符级输入（API Key / 模型名 / 数字输入框）的落盘入口：350ms 防抖，最后一次为准。
 * `onSettled`（v0.23.2）：真正写盘成功/失败后触发——API Key 输入框据此显示
 * 「✓ 已保存」。连续输入时中间回调被丢弃，只有最终落盘对应的回调触发。
 */
export function queueSettingsSave(settings: AppSettings, onSettled?: (ok: boolean) => void): void {
  saveQueue.queue(settings, onSettled);
}

/** 立即落盘防抖队列（输入框 blur / 设置面板卸载时调用，最后一次输入不丢） */
export function flushSettingsSave(): void {
  saveQueue.flush();
}

/** 当前提供商是否可用（Key 要求满足）——发送前/连通性测试的闸门 */
export function isProviderReady(settings: AppSettings): { ok: boolean; reason?: string } {
  const preset = getPreset(settings.providerId);
  if (!preset) return { ok: false, reason: "未知提供商" };
  if (preset.requiresKey && !(settings.apiKeys[preset.id] ?? "").trim()) {
    return { ok: false, reason: `请先在设置中填写 ${preset.label} 的 API Key` };
  }
  return { ok: true };
}
