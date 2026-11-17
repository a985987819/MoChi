/**
 * 宠物素材导入（v0.9.2）—— 「素材」Tab 的数据与动作层。
 *
 * # 这一层负责什么
 *
 * 1. **双语状态说明书**：每个状态叫什么（中/英）、什么时候出现。用户导入前要先知道自己
 *    在给"什么时刻"配图，否则十张图放进去也不知道哪张会在什么时候出现。
 * 2. **从文件名猜状态**：用户手上的图往往叫「开心.png」「难过_2.jpg」，导入时按别名
 *    识别状态，用户再在页面上确认。
 * 3. **英文命名规划**：导入后统一落成 `{state}.{ext}` / `{state}_N.{ext}` —— 项目里
 *    的状态机只认英文代码，中文文件名永远匹配不上（parseAssetName 只做扩展名归一）。
 * 4. **写入**：交给 Rust `save_pet_asset`（前端没有文件系统权限，见 AGENTS.md 权限最小化）。
 *
 * # 为什么"改名"发生在导入这一步
 *
 * 用户目录里已经被识别过的中文名素材（v0.2.0 起 parseAssetName 只解析英文状态）其实
 * 从未生效。与其让用户在资源管理器里手动改名，不如在导入时一次性落成规范名——
 * 这也是用户提出的诉求："导入项目当中自动改为英文命名供项目使用"。
 */

import { invoke } from "@tauri-apps/api/core";
import { PET_STATES, type PetState } from "@/services/pet-state";
import { parseAssetFile } from "@/services/pet-assets";

/** 支持导入的扩展名（与 Rust PET_ASSET_EXTS、pet-assets.ts SUPPORTED_EXTS 一致） */
export const IMPORT_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg"] as const;

/** 一个状态的双语说明：页面直接渲染，docs/pet-assets.md §3 与之同源 */
export interface StateDoc {
  /** 状态代码 = 素材文件名（项目内部唯一标识，永远是英文） */
  state: PetState;
  /** 中文名（用户看到的标题） */
  zh: string;
  /** 英文名（与状态代码同形，给英文用户与文件名对照） */
  en: string;
  /** 什么时候会出现（中文） */
  zhWhen: string;
  /** 什么时候会出现（English） */
  enWhen: string;
  /** 从文件名猜状态的别名（小写；含中文与英文口语） */
  aliases: string[];
}

/**
 * 状态清单（顺序 = 页面展示顺序 = 从"最常见"到"最特殊"）。
 * 文案标准：一句说清"什么时候会出现"，不解释实现（用户不需要知道 Slot 仲裁）。
 */
export const STATE_DOCS: readonly StateDoc[] = [
  {
    state: "idle",
    zh: "待机",
    en: "Idle",
    zhWhen: "默认状态，没有别的事情发生时一直用它",
    enWhen: "Default look when nothing else is happening",
    aliases: ["待机", "默认", "发呆", "idle", "default", "normal"],
  },
  {
    state: "happy",
    zh: "开心",
    en: "Happy",
    zhWhen: "被夸奖时；也可以右键宠物手动演示",
    enWhen: "When you praise it, or demo it from the pet's right-click menu",
    aliases: ["开心", "高兴", "快乐", "笑", "happy", "smile", "joy"],
  },
  {
    state: "sad",
    zh: "难过",
    en: "Sad",
    zhWhen: "被批评/被拒绝时",
    enWhen: "When it gets criticized or turned down",
    aliases: ["难过", "伤心", "委屈", "沮丧", "sad", "cry"],
  },
  {
    state: "thinking",
    zh: "思考",
    en: "Thinking",
    zhWhen: "模型正在推理、还没开始回答时",
    enWhen: "While the model is reasoning before it answers",
    aliases: ["思考", "想想", "疑惑", "推理", "thinking", "think"],
  },
  {
    state: "talking",
    zh: "说话",
    en: "Talking",
    zhWhen: "回复正在输出时（逐字出现的那几秒）",
    enWhen: "While a reply is streaming out",
    aliases: ["说话", "聊天", "回复", "talking", "talk", "speak"],
  },
  {
    state: "alert",
    zh: "该站起来了",
    en: "Stand-up alert",
    zhWhen: "坐太久触发站立提醒时（优先级最高）",
    enWhen: "When the stand-up reminder fires (highest priority)",
    aliases: ["提醒", "站立", "起来", "alert", "standup", "stand"],
  },
  {
    state: "stretch",
    zh: "伸展",
    en: "Stretch",
    zhWhen: "点击提醒弹窗确认后，奖励式伸展一下",
    enWhen: "Right after you confirm a reminder — a little stretch reward",
    aliases: ["伸展", "拉伸", "伸懒腰", "stretch"],
  },
  {
    state: "focus",
    zh: "专注",
    en: "Focus",
    zhWhen: "番茄钟专注阶段",
    enWhen: "During a pomodoro focus session",
    aliases: ["专注", "工作", "学习", "番茄", "focus", "work", "study"],
  },
  {
    state: "break",
    zh: "休息",
    en: "Break",
    zhWhen: "番茄钟休息阶段",
    enWhen: "During a pomodoro break",
    aliases: ["休息", "放松", "break", "rest"],
  },
  {
    state: "sleep",
    zh: "睡着",
    en: "Sleep",
    zhWhen: "你离开电脑、一段时间没有输入时",
    enWhen: "After you leave the computer for a while",
    aliases: ["睡觉", "睡眠", "离开", "挂机", "睡着", "sleep", "away"],
  },
] as const;

/** 状态代码集合（来自状态机，避免本文件与 PET_STATES 漂移） */
const STATE_CODES = new Set<string>(PET_STATES);

/** 别名 → 状态 的扁平索引（长度降序，供"包含匹配"取最长命中） */
const ALIAS_INDEX: ReadonlyArray<{ alias: string; state: PetState }> = STATE_DOCS
  .flatMap(doc => doc.aliases.map(alias => ({ alias, state: doc.state })))
  .sort((a, b) => b.alias.length - a.alias.length);

/** 去掉变体序号与"副本"尾巴：happy_2 / 开心_副本 / 开心 (1) → 干净词干 */
function normalizeStem(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "").toLowerCase().trim();
  return stem.replace(/[\s_-]*(?:\d+|副本|拷贝|copy|\(\d+\))$/u, "").trim();
}

/**
 * 文件名 → 状态代码；认不出返回 null（页面让用户手动选，不猜）。
 *
 * 匹配顺序：① 词干正好是状态代码（导入过的规范名）；② 别名精确命中；
 * ③ 别名包含（"我的开心表情"）；包含匹配按别名长度优先，避免「休息」抢「休息中」。
 */
export function guessStateFromFileName(fileName: string): PetState | null {
  const stem = normalizeStem(fileName);
  if (!stem) return null;
  if (STATE_CODES.has(stem)) return stem as PetState;
  const exact = ALIAS_INDEX.find(entry => entry.alias === stem);
  if (exact) return exact.state;
  const contained = ALIAS_INDEX.find(entry => stem.includes(entry.alias));
  return contained?.state ?? null;
}

/** 文件名 → 归一后的扩展名（jpeg → jpg）；不在白名单返回 null */
export function extOfFileName(fileName: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(fileName);
  if (!match) return null;
  const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  return IMPORT_EXTS.includes(ext as (typeof IMPORT_EXTS)[number]) || ext === "jpg" ? ext : null;
}

/**
 * 从文件名里取出**帧序号**（v0.10.0）：`开心_001.png` → 1，`idle_2.png` → null。
 *
 * 为什么要单独认这个：帧序列（`_001`…）和变体（`_2`…）在导入时命运不同——
 * 变体要改成"下一个可用序号"，帧必须**保住原序号**，否则 `_003` 被改成 `_2`
 * 会直接打乱播放顺序。用户从 Aseprite 之类导出时天然就是三号零填充。
 */
export function frameOfFileName(fileName: string): number | null {
  const parts = parseAssetFile(fileName);
  return parts?.frame && parts.frame > 0 ? parts.frame : null;
}

/**
 * 规划落盘文件名（**预览用**，最终名字由 Rust 写盘时决定）。
 *
 * - 帧号存在时：`{state}_{NNN}.{ext}`，序号原样保留（同名即"重导同一帧"，允许覆盖）；
 * - 否则与 Rust `next_asset_file_name` 同一算法：`{state}.{ext}` → `_2` → `_3`…，
 *   并接受 `reserved`（本批已排队的名字）避免同批互相抢名。
 */
export function targetFileName(
  state: string,
  ext: string,
  existing: readonly string[],
  reserved: readonly string[] = [],
  frame: number | null = null,
): string {
  if (frame !== null && frame > 0) {
    // 帧名由序号唯一决定：不避让、不递增——挪位就是错位
    return `${state}_${String(frame).padStart(3, "0")}.${ext}`;
  }
  const taken = new Set([...existing, ...reserved].map(name => name.toLowerCase()));
  const base = `${state}.${ext}`;
  if (!taken.has(base)) return base;
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${state}_${index}.${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${state}_${Date.now()}.${ext}`;
}

/** 读文件为纯 base64（剥掉 data URL 前缀）——Rust 侧自己解码，不依赖额外插件 */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error("读取图片失败"));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

/** 写入一张素材，返回 Rust 决定的最终文件名（成功即已落盘到 pet-assets/） */
export async function savePetAsset(
  state: PetState,
  ext: string,
  base64: string,
  frame: number | null = null,
): Promise<string> {
  return invoke<string>("save_pet_asset", { state, ext, base64, frame });
}

/** 用户目录现有素材：{ 状态: [完整路径] }（目录不存在时返回空对象） */
export async function listUserAssets(): Promise<Record<string, string[]>> {
  try {
    return await invoke<Record<string, string[]>>("list_user_pet_assets");
  } catch {
    return {};
  }
}

/** 从路径取文件名（Windows 反斜杠与 POSIX 斜杠都吃） */
export function fileNameOf(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop() ?? path;
}
