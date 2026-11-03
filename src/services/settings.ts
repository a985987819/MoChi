/**
 * 应用设置持久化 —— tauri-plugin-store（KV JSON，落 appData/settings.json）。
 *
 * 安全规范（AGENTS.md）：API Key 只存这里；禁止硬编码、入仓库、入日志。
 * 结构设计：apiKeys/models 按 providerId 分桶——切换提供商不丢各自的配置。
 * v0.7.0 的计时器配置（间隔/番茄钟时长）也进这个文件。
 */

import { load } from "@tauri-apps/plugin-store";
import { getPreset } from "@/agent/providers/presets";
import { emit } from "@tauri-apps/api/event";
import { STATE_EVENTS } from "@/shared/events";

export interface AppSettings {
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
   * 是否已完成首次启动引导（v0.9.0）。
   *
   * 为什么把「引导是否看过」放在设置里而不是 localStorage：
   * 1. 设置本来就随应用走 `tauri-plugin-store`，重装/升级后仍然记得；
   * 2. 引导文案与设置项强相关（第 3 步直接跳设置 Tab），放一起便于版本演进时
   *    用 key 名做迁移（例如将来 onboardingVersion: 2 触发增量引导）；
   * 3. 设置页「重新显示新手引导」= 把它置回 false，零额外状态。
   */
  onboardingDone: boolean;
}

const STORE_FILE = "settings.json";
const KEY = "app";

export function defaultSettings(): AppSettings {
  return {
    providerId: "mock",
    apiKeys: {},
    models: {},
    standupIntervalMin: 60,
    pomodoroFocusMin: 25,
    pomodoroBreakMin: 5,
    notificationsEnabled: true,
    onboardingDone: false,
  };
}

/** 数值字段夹紧（防设置页输入 0/负数/离谱值） */
const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? Math.round(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function normalize(raw: unknown): AppSettings {
  const d = defaultSettings();
  if (typeof raw !== "object" || raw === null) return d;
  const r = raw as Partial<AppSettings>;
  return {
    providerId: typeof r.providerId === "string" && getPreset(r.providerId) ? r.providerId : d.providerId,
    apiKeys: typeof r.apiKeys === "object" && r.apiKeys !== null ? r.apiKeys : d.apiKeys,
    models: typeof r.models === "object" && r.models !== null ? r.models : d.models,
    standupIntervalMin: clampInt(r.standupIntervalMin, 1, 120, d.standupIntervalMin),
    pomodoroFocusMin: clampInt(r.pomodoroFocusMin, 5, 90, d.pomodoroFocusMin),
    pomodoroBreakMin: clampInt(r.pomodoroBreakMin, 1, 30, d.pomodoroBreakMin),
    notificationsEnabled: typeof r.notificationsEnabled === "boolean" ? r.notificationsEnabled : d.notificationsEnabled,
    // 老版本 settings.json 没有这个字段：undefined → false（当作没看过引导）。
    // 这正是「升级用户也会看到一次引导」的期望行为——v0.9.0 之前没有引导。
    onboardingDone: typeof r.onboardingDone === "boolean" ? r.onboardingDone : d.onboardingDone,
  };
}

let storePromise: Promise<Awaited<ReturnType<typeof load>>> | null = null;

/** store 实例单例（plugin-store 的 load 幂等，但收敛到一处便于替换实现） */
function getStore() {
  storePromise ??= load(STORE_FILE, { autoSave: true });
  return storePromise;
}

export async function loadSettings(): Promise<AppSettings> {
  const store = await getStore();
  return normalize(await store.get<AppSettings>(KEY));
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const store = await getStore();
  await store.set(KEY, settings); // autoSave: true → 自动落盘
  // 广播给常驻服务（TimerService 等）重载配置——learning/08：改站立间隔即重置计时
  await emit(STATE_EVENTS.settingsChanged, { keys: Object.keys(settings) });
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
