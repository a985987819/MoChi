import type { AddressingPreferences } from "@/shared/addressing";
import { normalizeAddressing } from "@/shared/addressing";
import type { PetState } from "@/services/pet-state";
import { CHATTER_LINES, type ChatterCategory } from "@/services/pet-chatter-lines";

/** 只使用已有应用信号，不把活动时长解释为真实工作强度或久坐时长。 */
export interface ChatterContext {
  now: Date;
  petState: PetState;
  phase: "idle" | "focus" | "break";
  activeMinutes: number;
  recentlyReturned: boolean;
  names: AddressingPreferences;
}

/** 独立于 UI 的选择结果，保留类别和稳定 id，便于验证路由、轮换与词库维护。 */
export interface BubbleLine { id: string; text: string; category: ChatterCategory; }

/** 本地时段划分，保证凌晨也有温柔收尾而非继续熬夜的鼓励。 */
export function chatterTimeOfDay(hour: number): ChatterCategory {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "noon";
  if (hour >= 14 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

/** 气泡显示空间有限，长称呼仅在此摘要；不修改设置中的原文或对话称呼。 */
function compactName(text: string): string {
  const characters = Array.from(text.replace(/\s+/g, " "));
  return characters.length > 8 ? `${characters.slice(0, 7).join("")}…` : characters.join("");
}

/**
 * 预写文案在单击路径离线选择，避免每次摸摸都访问模型或等待网络。
 * 优先路由真实应用状态，类别轮换与最近12条id共同去重，持续摸摸也不只说同一句。
 */
export class PetChatter {
  private recent: string[] = [];
  private recentCategories: ChatterCategory[] = [];
  private lastClickAt = Number.NEGATIVE_INFINITY;
  private taps = 0;
  private greetedReturn = false;
  private greetedReturnAt = Number.NEGATIVE_INFINITY;
  private lastContext: ChatterCategory | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  /** 每次确认的单击才调用；不改变宠物状态、站立截止时间或番茄钟。 */
  next(input: ChatterContext): BubbleLine {
    const now = input.now.getTime();
    this.taps = now - this.lastClickAt >= 0 && now - this.lastClickAt < 15_000 ? this.taps + 1 : 1;
    this.lastClickAt = now;
    if (!input.recentlyReturned) this.greetedReturn = false;

    // 专注/休息是明确状态；普通“活动中”只说明输入恢复，不推断用户在忙什么。
    const contextual: ChatterCategory = input.phase === "focus" ? "focus"
      : input.phase === "break" ? "break"
      : input.petState === "sad" ? "comfort"
      : input.activeMinutes >= 45 ? "long-session" : chatterTimeOfDay(input.now.getHours());
    let category: ChatterCategory;
    if (input.recentlyReturned && (!this.greetedReturn || now - this.greetedReturnAt >= 60_000)) {
      category = "return";
      this.greetedReturn = true;
      this.greetedReturnAt = now;
    } else if (contextual !== this.lastContext) {
      category = contextual; // 阶段/时段改变后的第一次点击，先回应当前语境。
    } else if (this.taps >= 3 && this.recentCategories[0] !== "playful") {
      category = "playful";
    } else {
      // 第一次根据上下文回应，其后在同一语境中穿插陪伴/轻松/关心，而不是轮番催休息。
      const choices: ChatterCategory[] = [contextual, contextual, "everyday", "comfort", "playful"];
      if (this.recentCategories.length === 0) category = contextual;
      else {
        const candidates = choices.filter(value => value !== this.recentCategories[0]);
        category = this.pick(candidates.length ? candidates : choices);
      }
    }
    const pool = CHATTER_LINES.filter(line => line.category === category);
    // 每类至少8条，最近窗口耗尽时降级为仅避开上一条，绝不返回undefined。
    const fresh = pool.filter(line => !this.recent.includes(line.id));
    const fallback = pool.filter(line => line.id !== this.recent[0]);
    const chosen = this.pick(fresh.length ? fresh : fallback.length ? fallback : pool);
    this.lastContext = contextual;
    this.recent = [chosen.id, ...this.recent].slice(0, 12);
    this.recentCategories = [category, ...this.recentCategories].slice(0, 3);
    const names = normalizeAddressing(input.names);
    // 单次正则替换，不会把用户名字里恰好含有的占位符再解释一遍。
    const text = chosen.text.replace(/\{(pet|user)\}/g, (_token, name: string) =>
      compactName(name === "pet" ? names.petSelfName : names.userNickname));
    return { id: chosen.id, category, text };
  }

  private pick<T>(items: readonly T[]): T {
    const value = this.random();
    const fraction = Number.isFinite(value) ? Math.max(0, Math.min(0.999999, value)) : 0;
    return items[Math.floor(fraction * items.length)];
  }
}
