/**
 * 提供商预设表 —— 规格：docs/learning/02-provider-abstraction.md §4.4。
 *
 * 核心思想：**差异是数据不是逻辑**。新增一个 OpenAI 兼容提供商 = 加一行预设，零代码。
 * 模型列表以各官方文档为准（这是唯一需要跟进维护的数据）。
 */

export interface ProviderPreset {
  id: string;
  label: string;
  baseURL: string;
  defaultModel: string;
  models: string[];
  requiresKey: boolean;
  /** 引导用户去哪申请 Key（设置页展示） */
  keysUrl?: string;
  notes?: string;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    requiresKey: true,
    keysUrl: "https://platform.deepseek.com",
    notes: "工具调用（v0.4.0）请使用 deepseek-chat",
  },
  {
    id: "moonshot",
    label: "Kimi",
    baseURL: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "kimi-k2-0711-preview"],
    requiresKey: true,
    keysUrl: "https://platform.moonshot.cn",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseURL: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
    requiresKey: true,
    keysUrl: "https://siliconflow.cn",
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    baseURL: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:7b",
    models: [], // 本机模型动态变化，设置页允许手填
    requiresKey: false,
    notes: "需本机已运行 Ollama；模型名按 ollama list 填写",
  },
  {
    id: "mock",
    label: "Mock（无 Key 调试）",
    baseURL: "",
    defaultModel: "mock",
    models: ["mock"],
    requiresKey: false,
    notes: "本地假 Provider，全流程可开发可演示，不产生费用",
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PRESETS.find(p => p.id === id);
}
