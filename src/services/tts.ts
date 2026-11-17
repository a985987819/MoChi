/**
 * TTS 朗读服务（P1-03 / v0.15.0）—— 免费音源：Web Speech API（系统语音包）。
 *
 * # 方案决策（用户指令：TTS 用免费音源，云端不做）
 *
 * 三选一里选了 Web Speech API（任务单 P1-03 的推荐原型路线）：
 * - **零依赖、零 Key、离线可用**：读的是系统语音包（Windows 的 Huihui/Kangkang、
 *   macOS 的 Tingting…），与"离线可用"的产品气质一致；云端 TTS 音色好但要么要
 *   Key（凭据面）要么联网（隐私面），与任务单的"不建议"结论一致；
 * - **代价**：音色机械、依赖系统语音包——所以默认关（见 SettingsTab 的说明文案
 *   与版本文档的"为什么默认关"）。
 *
 * # 生命周期
 *
 * - `configureTts`：设置变更入口（聊天窗监听 settingsChanged 后调用）；
 *   关开关立即停读，不留半句；
 * - `speak`：只在**回复完整结束后**调用（流式中朗读会结巴——任务单的坑）；
 *   内部顺序：开关 → 打断上一条 → 免打扰 → 纯文本化 → 截断 → 选音色；
 * - `stopSpeaking`：新消息发出 / 用户点击宠物 / 聊天窗关闭时由 ChatTab 调用。
 *
 * # 可测性
 *
 * 验收标准要求"开关关闭时不调用 speechSynthesis（注入假对象断言）"——运行时
 * 通过 `setTtsRuntimeForTests` 整体可替换（synthesis + utterance 工厂）。生产代码
 * 不要用它；vitest 是 node 环境，没有真 Web Speech。
 */

import { isQuietHour } from "@/services/quiet-hours";
import type { AppSettings } from "@/services/settings";

/** 结构子集：测试假对象只需实现这些；真 window.speechSynthesis 结构兼容 */
export interface SpeechSynthesisVoiceLike {
  name: string;
  lang: string;
}

export interface SpeechSynthesisUtteranceLike {
  text: string;
  rate: number;
  volume: number;
  voice: SpeechSynthesisVoiceLike | null;
  // onerror 刻意不进结构子集：真实 SpeechSynthesisUtterance 的 onerror 签名较窄
  // （SpeechSynthesisErrorEvent），放进接口会让"真对象赋给子集类型"报双向不兼容。
  // 错误记录在 speak() 里经一次受控赋值完成（见那里的注释）。
}

export interface SynthesisLike {
  cancel(): void;
  speak(utterance: SpeechSynthesisUtteranceLike): void;
  /** 真 SpeechSynthesis 有；假对象没实现时按"不可知"处理（不靠它做门禁） */
  speaking?: boolean;
  getVoices?(): SpeechSynthesisVoiceLike[];
  addEventListener?(type: "voiceschanged", cb: () => void): void;
  removeEventListener?(type: "voiceschanged", cb: () => void): void;
}

export interface TtsConfig {
  enabled: boolean;
  /** 0.5~2.0，1 = 系统默认语速 */
  rate: number;
  /** 按音色名指定；空 = 自动（zh-CN 优先，见 pickVoice） */
  voiceName: string;
  quietHours: { enabled: boolean; start: number; end: number };
}

// ── 文本处理（纯函数，验收单测覆盖）──────────────────────────────────

/**
 * Markdown → 可朗读纯文本。**不要把符号念出来**（任务单的坑）：
 * 代码块整体跳过（念变量名是灾难）、图片跳过、链接念文字、粗斜体去标记、
 * 标题井号与列表符去掉。没有 Markdown 语法时原样返回（中文零损伤）。
 */
export function plainTextForSpeech(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?```/g, " ") // 围栏代码块：整体跳过
      .replace(/`([^`]*)`/g, "$1") // 行内代码：念内容不念反引号
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // 图片：跳过
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接：念显示文字
      .replace(/^#{1,6}\s+/gm, "") // 标题井号
      .replace(/\*\*([^*]+)\*\*/g, "$1") // 粗体
      .replace(/\*([^*]+)\*/g, "$1") // 斜体
      .replace(/^\s*[-*+]\s+/gm, "") // 无序列表符
      .replace(/^\s*>\s?/gm, "") // 引用符
      .replace(/\s+/g, " ") // 连续空白合并（换行念不出停顿）
      .trim()
  );
}

/** 超长回复只念前 N 字（任务单建议 200）：念三分钟没人听完 */
export function trimForSpeech(text: string, limit = 200): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}……长回答只念到这里，其余在聊天窗里`;
}

// ── 运行时（可注入）────────────────────────────────────────────────

const defaultSynthGetter = (): SynthesisLike | null =>
  typeof window !== "undefined" && window.speechSynthesis
    ? (window.speechSynthesis as unknown as SynthesisLike)
    : null;

const defaultUtteranceFactory = (text: string): SpeechSynthesisUtteranceLike =>
  new SpeechSynthesisUtterance(text);

let synthGetter: () => SynthesisLike | null = defaultSynthGetter;
let utteranceFactory: (text: string) => SpeechSynthesisUtteranceLike = defaultUtteranceFactory;

/**
 * 测试注入点（验收标准：注入假对象断言调用次数）。传 null 恢复默认。
 * 结构：{ synth, utterance }——synthesis 返回假对象，utterance 工厂返回带字段
 * 的普通对象，让断言能检查 rate/voice/text。
 */
export function setTtsRuntimeForTests(runtime: {
  synth: SynthesisLike | null;
  utterance?: (text: string) => SpeechSynthesisUtteranceLike;
} | null): void {
  synthGetter = runtime ? (runtime.synth === null ? () => null : () => runtime.synth) : defaultSynthGetter;
  utteranceFactory = runtime?.utterance ?? defaultUtteranceFactory;
}

// ── 配置与播报 ─────────────────────────────────────────────────────

let config: TtsConfig = {
  enabled: false,
  rate: 1,
  voiceName: "",
  quietHours: { enabled: false, start: 22, end: 8 },
};

/** 设置变更入口；关开关立即停读（半句悬着比不读更怪） */
export function configureTts(next: Partial<TtsConfig>): void {
  config = { ...config, ...next };
  if (!config.enabled) stopSpeaking();
}

/** 从持久化设置映射 TTS 配置（聊天窗启动与 settingsChanged 时调用） */
export function applyTtsFromSettings(settings: AppSettings): void {
  configureTts({
    enabled: settings.ttsEnabled,
    rate: settings.ttsRate,
    voiceName: settings.ttsVoiceName,
    quietHours: {
      enabled: settings.quietHoursEnabled,
      start: settings.quietStartHour,
      end: settings.quietEndHour,
    },
  });
}

/**
 * 朗读一段文本。内部保证：
 * 1. 开关关闭 → **不触碰** speechSynthesis（连 cancel 都不调，验收红线）；
 * 2. 免打扰时段 → 不读（与音效同一条礼貌规则）；
 * 3. 新 speak 打断上一条（speechSynthesis 对同一时间只播一条的处理各平台不一，
 *    统一先 cancel——任务单明确不要用 pause）；
 * 4. Markdown 纯文本化 + 200 字截断；纯代码块回复没的可念，静默。
 */
export function speak(text: string): void {
  if (!config.enabled) return;
  if (config.quietHours.enabled && isQuietHour(Date.now(), config.quietHours.start, config.quietHours.end)) {
    return;
  }
  const plain = trimForSpeech(plainTextForSpeech(text));
  if (!plain) return; // 整段是代码/空文本：没的可念
  stopSpeaking(); // 打断上一条：连续两条只念最后一条
  const synth = synthGetter();
  if (!synth) return; // 环境不支持（真机 WebView2 都支持；node 测试注入假对象）
  const utterance = utteranceFactory(plain);
  utterance.rate = config.rate;
  // 朗读音量恒 1（独立于音效音量——任务单的坑）：混在一个音量里会把"点击哒声"
  // 和"说话声"绑死，调小音效连人声也听不见。要更小声用系统音量。
  utterance.volume = 1;
  const voice = pickVoice(synth, config.voiceName);
  utterance.voice = voice ?? null;
  // 错误记录走受控赋值而非接口字段：真实 onerror 的参数类型窄于通用记录签名，
  // 结构子集里声明它会破坏"真对象 → 子集类型"的赋值方向（只记录不转发，无类型损失）。
  (utterance as { onerror?: unknown }).onerror = (event: unknown) =>
    console.error("[tts] 朗读失败:", event);
  synth.speak(utterance);
}

/** 立即停读（新消息 / 点击宠物 / 关窗时调用；未在朗读时是安全的空操作） */
export function stopSpeaking(): void {
  const synth = synthGetter();
  // speaking 守卫：没在读就不 cancel——配置初始化/开关切换等高频路径不必惊动合成器，
  // 测试里"配置动作"与"朗读动作"的调用次数也就此分开（谁都没被谁污染）。
  if (synth?.speaking) synth.cancel();
}

/**
 * 音色挑选：显式指定名 → 精确匹配；否则 zh-CN → 任意 zh → 默认（不设 voice）。
 * Chrome/WebView2 首次 getVoices() 可能为空（voiceschanged 之后才有）——返回
 * undefined 让系统用默认音色，UI 层用 listTtsVoices/subscribeVoices 提示"没有中文音色"。
 */
function pickVoice(synth: SynthesisLike, preferredName: string): SpeechSynthesisVoiceLike | undefined {
  const voices = synth.getVoices?.() ?? [];
  if (voices.length === 0) return undefined;
  if (preferredName) {
    return voices.find(v => v.name === preferredName);
  }
  const zhCn = voices.find(v => v.lang.toLowerCase().startsWith("zh-cn"));
  if (zhCn) return zhCn;
  return voices.find(v => v.lang.toLowerCase().startsWith("zh"));
}

/** 设置页音色下拉的数据源；不支持/没就绪时返回空数组（UI 显示"系统默认"） */
export function listTtsVoices(): SpeechSynthesisVoiceLike[] {
  return synthGetter()?.getVoices?.() ?? [];
}

/**
 * 订阅系统音色列表变化（voiceschanged）：WebView2/Chrome 异步枚举音色，
 * 首次常为空，事件到达后设置页要刷新下拉。
 */
export function subscribeVoices(cb: () => void): () => void {
  const synth = synthGetter();
  const add = synth?.addEventListener;
  const remove = synth?.removeEventListener;
  if (!add || !remove) return () => undefined;
  add.call(synth, "voiceschanged", cb);
  return () => remove.call(synth, "voiceschanged", cb);
}
