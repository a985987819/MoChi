/**
 * 宠物素材解析器 —— 回退链：用户目录 > 内置素材 > null（渲染层显示占位 SVG）。
 * 约定规格：docs/pet-assets.md §1~§2。
 *
 * # 两个数据源
 *
 * 1. **用户目录** `{appData}/pet-assets/`：Rust 命令 `list_user_pet_assets` 扫描
 *    （前端不申请文件系统权限——权限最小化，见 AGENTS.md 代码规范）。
 *    每次解析都重新扫描：目录极小（~10 文件），一次 readdir 毫秒级，
 *    换来"放图即生效、删图即回落"——比文件监视（notify watcher + 事件桥）简单一个量级。
 * 2. **内置素材** `src/assets/pet/*`：Vite `import.meta.glob` 构建期导入，
 *    产物是带 hash 的静态 URL，无运行时开销。
 *
 * # 变体与动画
 *
 * `{state}.{ext}` 与 `{state}_N.{ext}` 同属一个状态的变体池；`gif`/`webp` 标记为
 * animated（渲染层对 animated 变体不轮换，见 pet-assets.md §2）。
 */

import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { PetState } from "@/services/pet-state";

const SUPPORTED_EXTS = new Set(["png", "jpg", "gif", "webp", "svg"]);
const ANIMATED_EXTS = new Set(["gif", "webp"]);

export interface PetVariant {
  /** 可直接放进 <img src> 的 URL（用户文件经 asset 协议，内置文件是构建产物） */
  url: string;
  /**
   * 帧序列（v0.10.0）：存在且长度 >= 2 时，渲染层按序循环播放这些 URL。
   * `url` 此时等于 `frames[0]`，方便"只想要一张图"的调用方（如气泡缩略）直接用。
   */
  frames?: string[];
  animated: boolean;
  /** true = 来自用户目录（调试提示用，UI 可显示"自定义素材"角标） */
  fromUser: boolean;
}

/** 内置素材：构建期固定映射 文件名 → Vite 产物 URL */
const bundledUrls: Map<string, string> = new Map(
  Object.entries(
    import.meta.glob<string>("@/assets/pet/*.{png,jpg,jpeg,gif,webp,svg}", {
      eager: true,
      query: "?url",
      import: "default",
    }),
  ).map(([path, url]) => [path.split("/").pop() ?? "", url]),
);

/**
 * 素材文件的三段信息：状态、扩展名、以及"这是第几帧 / 第几个变体"。
 *
 * v0.10.0 起有两条**并存**的编号语义，靠位数区分（docs/pet-assets.md §2）：
 * - `idle_2.png`：1~2 位 → **变体**（同状态的另一张静态图，随机轮换用）
 * - `idle_001.png`：3 位零填充 → **帧**（帧序列的一帧，按序号循环播放）
 *
 * 为什么用位数而不是新前缀（如 `idle_anim_01`）：桌宠素材多是用户从别的工具导出的
 * 序号命名，3 位零填充是逐帧动画的行业惯例（Aseprite/Spine 导出都是这样）；
 * 而变体没有"顺序"含义，用户手写时天然是 `_2`、`_3` 这种短序号。两者不会互相误伤。
 */
export interface AssetFileParts {
  state: string;
  ext: string;
  /** 大于 0 = 帧序号（1 起）；null = 不是帧 */
  frame: number | null;
  /** 大于 0 = 变体序号；null = 基础形态（无序号） */
  variant: number | null;
}

/**
 * 解析素材文件名。`{state}.{ext}` / `{state}_{N}.{ext}` / `{state}_{NNN}.{ext}` 都合法；
 * 不符合约定或扩展名不支持时返回 null。
 */
export function parseAssetFile(name: string): AssetFileParts | null {
  const match = /^(.+?)(?:_(\d+))?\.(png|jpe?g|gif|webp|svg)$/i.exec(name);
  if (!match) return null;
  const rawExt = match[3].toLowerCase();
  const ext = rawExt === "jpeg" ? "jpg" : rawExt;
  if (!SUPPORTED_EXTS.has(ext)) return null;
  const digits = match[2];
  // 三位且零填充（001、012）才算帧；`_1`/`_12` 是变体，`_1234` 这类超长数字按变体处理
  const isFrame = typeof digits === "string" && digits.length === 3;
  return {
    state: match[1].toLowerCase(),
    ext,
    frame: isFrame ? Number(digits) : null,
    variant: typeof digits === "string" && !isFrame ? Number(digits) : null,
  };
}

/** 解析素材文件名 → { state, ext }；不符合约定的名字返回 null（pet-assets.md §2）。 */
export function parseAssetName(name: string): { state: string; ext: string } | null {
  const parts = parseAssetFile(name);
  return parts ? { state: parts.state, ext: parts.ext } : null;
}


/**
 * 一组同名状态的素材 → 变体池。
 *
 * 规则（v0.10.0）：
 * - 该状态有 **>=2 张帧**（`_001` 起）时，整组帧合成**一个变体**（`frames`），
 *   同时隐式放弃"随机轮换"——逐帧动画本身就是动态的，再轮换只会闪；
 * - 只有 1 张帧（用户可能只导了一帧）→ 当普通静态图，按变体参与轮换；
 * - 其余无帧号的文件是普通变体（gif/webp 标记 animated，渲染层不轮换）。
 */
function buildVariants(entries: ReadonlyArray<{ parts: AssetFileParts; url: string; fromUser: boolean }>): PetVariant[] {
  const frames = entries
    .filter(entry => entry.parts.frame !== null)
    .sort((a, b) => (a.parts.frame ?? 0) - (b.parts.frame ?? 0));
  const stills = entries.filter(entry => entry.parts.frame === null);

  const variants: PetVariant[] = [];
  if (frames.length >= 2) {
    const urls = frames.map(frame => frame.url);
    variants.push({ url: urls[0], frames: urls, animated: false, fromUser: frames[0].fromUser });
  } else {
    for (const frame of frames) {
      variants.push({ url: frame.url, animated: false, fromUser: frame.fromUser });
    }
  }
  for (const still of stills) {
    variants.push({
      url: still.url,
      animated: ANIMATED_EXTS.has(still.parts.ext),
      fromUser: still.fromUser,
    });
  }
  return variants;
}

/**
 * 取某状态优先级最高且未加载失败的一组变体（用户目录优先，内置垫底）。
 * 空数组 = 该状态无任何素材 → 渲染层显示占位 SVG。
 * 每次调用都重扫用户目录（见头注释"为什么不做 watcher"）。
 */
export async function listVariants(state: PetState, failedUrls: ReadonlySet<string> = new Set()): Promise<PetVariant[]> {
  const entries: Array<{ parts: AssetFileParts; url: string; fromUser: boolean }> = [];

  const collect = (name: string, url: string, fromUser: boolean): void => {
    const parts = parseAssetFile(name);
    if (parts && parts.state === state) entries.push({ parts, url, fromUser });
  };

  // ① 用户目录（Rust 扫描，返回 { 状态: [完整路径] }）
  try {
    const userMap = await invoke<Record<string, string[]>>("list_user_pet_assets");
    for (const path of userMap[state] ?? []) {
      const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
      collect(name, convertFileSrc(path), true);
    }
  } catch {
    // 扫描失败（目录不存在等）按"无用户素材"处理，静默走内置——回退链的意义
  }

  // ② 内置素材
  for (const [name, url] of bundledUrls) collect(name, url, false);

  // 用户在本次会话里加载失败的 URL 先剔除，再决定"用户优先还是内置兜底"——
  // 顺序反了会导致"用户图坏了就显示空白"，而不是回退到内置形象。
  const usable = entries.filter(entry => !failedUrls.has(entry.url));

  // 用户图与内置图不能混在一个随机池：否则“放图替换形象”只会偶尔生效。
  // img.onerror 由渲染层把失败 URL 回传；全部用户图失败时才退到内置图。
  const userEntries = usable.filter(entry => entry.fromUser);
  const chosen = userEntries.length > 0 ? userEntries : usable;
  return buildVariants(chosen);
}

/** 从变体池随机取一张 */
export function pickRandom<T>(arr: T[]): T | undefined {
  return arr.length === 0 ? undefined : arr[Math.floor(Math.random() * arr.length)];
}
