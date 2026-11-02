/**
 * Provider 工厂 —— 按设置实例化对应的 LLMProvider。
 * 规格：docs/learning/02-provider-abstraction.md §4.4~§4.5（差异进 presets 数据，逻辑只有两类实现）。
 */

import { MockProvider } from "./mock";
import { OpenAICompatProvider } from "./openai-compatible";
import { getPreset } from "./presets";
import type { AppSettings } from "@/services/settings";
import type { LLMProvider } from "./types";

export function createProvider(settings: AppSettings): LLMProvider {
  if (settings.providerId === "mock") return new MockProvider();
  const preset = getPreset(settings.providerId);
  if (!preset) throw new Error(`未知提供商: ${settings.providerId}`);
  return new OpenAICompatProvider(preset.id, {
    baseURL: preset.baseURL,
    apiKey: settings.apiKeys[preset.id],
    model: settings.models[preset.id] ?? preset.defaultModel,
  });
}

export { PRESETS, getPreset } from "./presets";
export type {
  LLMProvider,
  ChatMessage,
  ChatRequest,
  StreamEvent,
  ToolCall,
  ToolSpec,
  ProviderError,
  ProviderErrorKind,
} from "./types";
