/**
 * 气泡文本截断（v0.9.0 P1-01）——把 Agent 终答压成气泡能放下的一两句。
 *
 * 纯函数、零依赖：气泡文案策略要能单测（截断规则是"看起来对不对"的高发地），
 * 且 UI 层（ChatTab）与未来可能的宠物端复用都 import 它。
 *
 * 规则（按优先级）：
 * 1. 空白归一（Markdown 换行/多空格压成单空格）——气泡是单行小窗，不吃排版；
 * 2. ≤60 码点：原样返回（已经够短）；
 * 3. >60 码点：在前 60 码点内找**最后一个**中文/英文句读（。！？；…!?;），
 *    找到且句子长度 ≥12 码点则按句子截（保留完整句，不带省略号也自然）；
 * 4. 找不到合适句读：硬截 60 码点 +「…」。
 *
 * 用码点（[...str]）而不是 UTF-16 下标：emoji（如 🍅）是代理对，按下标截会
 * 把它劈成乱码——宠物应用里 emoji 出现在回复开头是常态。
 */

export const BUBBLE_MAX_CHARS = 60;
/** 句读截断的最短句长：比这还短的句子截出来信息量太低（如「好。」） */
const MIN_SENTENCE_CHARS = 12;
const SENTENCE_ENDINGS = "。！？；…!?;";

export function truncateForBubble(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  const chars = [...normalized];
  if (chars.length <= BUBBLE_MAX_CHARS) return normalized;

  const clipped = chars.slice(0, BUBBLE_MAX_CHARS).join("");
  // 从尾部找最后一个句读：完整句优先于硬截
  for (let i = clipped.length - 1; i >= MIN_SENTENCE_CHARS - 1; i--) {
    if (SENTENCE_ENDINGS.includes(clipped[i]!)) {
      return clipped.slice(0, i + 1);
    }
  }
  return clipped + "…";
}

/** 流式气泡的尾部展示上限（码点）：比完成摘要长一点，流式观感更像"在写" */
export const BUBBLE_STREAM_TAIL_MAX = 80;

/** 轻量 Markdown 符号剥离（流式中间态用）：不去代码块（流式截断态没法保证配对），只去明显符号 */
function stripMarkdownLite(text: string): string {
  return text
    .replace(/```[\s\S]*/g, " ") // 未闭合的代码块：从 ``` 到末尾都藏掉
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 流式气泡文本（v0.27.0）：取**尾部**——流式展示看的是"最新写到哪里"，
 * 不是开头。先剥 Markdown 符号再按码点截尾，开头加省略号表示"接上文"。
 */
export function tailForBubble(text: string, max = BUBBLE_STREAM_TAIL_MAX): string {
  const normalized = stripMarkdownLite(text);
  if (!normalized) return "";
  const chars = [...normalized];
  if (chars.length <= max) return normalized;
  return "…" + chars.slice(chars.length - max).join("");
}
