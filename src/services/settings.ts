/**
 * 应用设置持久化 —— tauri-plugin-store（KV JSON，落 appData/settings.json）。
 *
 * 安全规范（AGENTS.md）：API Key 只存这里；禁止硬编码、入仓库、入日志。
 * 结构设计：apiKeys/models 按 providerId 分桶——切换提供商不丢各自的配置。
 * v0.7.0 的计时器配置（间隔/番茄钟时长）也进这个文件。
 */

import { load } from "@tauri-apps/plugin-store";
import { getPreset } from "@/agent/providers/presets";

export interface AppSettings {
  /** 当前选中的提供商（presets.id 或 "mock"） */
  providerId: string;
  /** 每提供商独立保存 Key（格式随机，脱敏展示在 UI） */
  apiKeys: Record<string, string>;
  /** 每提供商选定的模型（未选过 = 预设 defaultModel） */
  models: Record<string, string>;
}

const STORE_FILE = "settings.json";
const KEY = "app";

export function defaultSettings(): AppSettings {
  return { providerId: "mock", apiKeys: {}, models: {} };
}

function normalize(raw: unknown): AppSettings {
  const d = defaultSettings();
  if (typeof raw !== "object" || raw === null) return d;
  const r = raw as Partial<AppSettings>;
  return {
    providerId: typeof r.providerId === "string" && getPreset(r.providerId) ? r.providerId : d.providerId,
    apiKeys: typeof r.apiKeys === "object" && r.apiKeys !== null ? r.apiKeys : d.apiKeys,
    models: typeof r.models === "object" && r.models !== null ? r.models : d.models,
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
