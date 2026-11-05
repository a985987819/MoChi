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
 * 解析素材文件名 → { state, ext }；不符合约定的名字返回 null（pet-assets.md §2）。
 * `{state}` 或 `{state}_N` 皆可；ext 统一小写、jpeg 归一为 jpg。
 */
export function parseAssetName(name: string): { state: string; ext: string } | null {
  const m = /^(.+?)(?:_\d+)?\.(png|jpe?g|gif|webp|svg)$/i.exec(name);
  if (!m) return null;
  const ext = m[2].toLowerCase() === "jpeg" ? "jpg" : m[2].toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) return null;
  return { state: m[1].toLowerCase(), ext };
}

/**
 * 取某状态优先级最高且未加载失败的一组变体（用户目录优先，内置垫底）。
 * 空数组 = 该状态无任何素材 → 渲染层显示占位 SVG。
 * 每次调用都重扫用户目录（见头注释"为什么不做 watcher"）。
 */
export async function listVariants(state: PetState, failedUrls: ReadonlySet<string> = new Set()): Promise<PetVariant[]> {
  const variants: PetVariant[] = [];

  const push = (name: string, url: string, fromUser: boolean): void => {
    const parsed = parseAssetName(name);
    if (parsed && parsed.state === state && !failedUrls.has(url)) {
      variants.push({ url, animated: ANIMATED_EXTS.has(parsed.ext), fromUser });
    }
  };

  // ① 用户目录（Rust 扫描，返回 { 状态: [完整路径] }）
  try {
    const userMap = await invoke<Record<string, string[]>>("list_user_pet_assets");
    for (const path of userMap[state] ?? []) {
      const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
      push(name, convertFileSrc(path), true);
    }
  } catch {
    // 扫描失败（目录不存在等）按"无用户素材"处理，静默走内置——回退链的意义
  }

  // ② 内置素材
  for (const [name, url] of bundledUrls) push(name, url, false);

  // 用户图与内置图不能混在一个随机池：否则“放图替换形象”只会偶尔生效。
  // img.onerror 由渲染层把失败 URL 回传；全部用户图失败时才退到内置图。
  const userVariants = variants.filter(variant => variant.fromUser);
  return userVariants.length > 0 ? userVariants : variants;
}

/** 从变体池随机取一张 */
export function pickRandom<T>(arr: T[]): T | undefined {
  return arr.length === 0 ? undefined : arr[Math.floor(Math.random() * arr.length)];
}
