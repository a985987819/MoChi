/**
 * 开机自动打开（v0.9.1）—— 应用服务：设置 ↔ 系统启动项的收纳层。
 *
 * # 边界（learning/07 功能归属裁决）
 *
 * 「开机时让麻薯出现」是**执行层**能力：写注册表 Run 键 / LaunchAgent 属于 OS
 * 权限，必须由 Rust 侧执行（tauri-plugin-autostart 统一封装三平台差异）。
 * 本文件是设置页与那条原生通道之间的**薄封装**：不存业务状态，只做
 * ① 把开关意图发给 Rust；② 读回系统真值；③ 把「意图 vs 真值」翻译成人话。
 *
 * # 为什么开关不直接 invoke 原生插件
 *
 * 原生插件（tauri-plugin-autostart）只给了 Rust API；前端若直连它，就得为
 * pet/chat/alert 三个窗口都开 autostart 权限（capability 扩面）。项目纪律是
 * 「系统级操作单一所有者」（AGENTS.md / lib.rs 头注释）：前端只发事件，
 * Rust 收事件执行并回执，权限面不扩大。
 *
 * # 为什么要有"真值回显"
 *
 * 设置文件是应用自己的数据，系统启动项是另一份事实，二者会因这些现实原因错位：
 * - 安全软件「启动项防护」静默回滚了注册表写入（enable() 依然返回 Ok）；
 * - 用户在任务管理器 → 启动应用里手工禁用了麻薯；
 * - 重装到别的目录后旧启动项指向不存在的 exe。
 * 只显示设置值就是"假成功"；本模块把 actual 状态交回 UI，让它说人话。
 */

import { invoke } from "@tauri-apps/api/core";
import { sendStateEvent, STATE_EVENTS } from "@/shared/events";

/** Rust 回执的形状（与 lib.rs 的 state://autostart-state 载荷一一对应） */
export interface AutostartSystemState {
  /** 系统里**此刻**是否真的会开机启动（Rust 读 is_enabled 得到） */
  enabled: boolean;
  /** 上一次应用是否成功——false 时 error 必有值 */
  ok: boolean;
  /** 失败原因（系统返回的短描述，不含用户路径/Key 等敏感信息） */
  error?: string;
}

/** 设置页提示条：tone 决定样式，text 是给用户看的一句话 */
export interface AutostartHint {
  tone: "none" | "ok" | "warn";
  text: string;
}

/**
 * 把「用户想要的」发给 Rust 应用（不等待系统结果——结果走 state://autostart-state
 * 事件回来，避免设置页因为一次注册表写入而卡住）。
 *
 * 事件发不出去（非 Tauri 环境，如浏览器预览/单测）时静默吞掉：设置值仍然落盘，
 * 下次在桌面端启动会由宠物窗的启动同步重新应用一次（自愈）。
 */
export async function applyAutostart(enabled: boolean): Promise<void> {
  await sendStateEvent(STATE_EVENTS.autostartChanged, { enabled }).catch(() => undefined);
}

/**
 * 读系统真值。null = 读不到（非 Tauri 环境 / 命令异常）——此时 UI 不显示任何
 * 对错判断，避免把"没法查"说成"没开"。
 */
export async function readSystemAutostart(): Promise<boolean | null> {
  try {
    return await invoke<boolean>("get_autostart_enabled");
  } catch {
    return null;
  }
}

/**
 * 「意图 + 系统真值」→ 提示条（纯函数，可单测）。
 *
 * 判定优先级：
 * 1. 读不到真值（system=null）→ 什么都不说（none）；
 * 2. 想要开、系统没开 → warn + 下一步（这才是需要用户动手的唯一情况）；
 * 3. 开且系统也有 → ok（给一次确认，用户才知道"真的生效了"）；
 * 4. 不想要、系统还留着 → warn（提示可用"重新应用"清掉）。
 *
 * @param desired 设置里的开关值（用户的意图）
 * @param system  Rust 回执/查询得到的系统真值；null = 未读到
 */
export function describeAutostart(
  desired: boolean,
  system: AutostartSystemState | null,
): AutostartHint {
  if (!system) return { tone: "none", text: "" };

  if (desired && system.ok && !system.enabled) {
    // 执行"成功"但系统里没有：最可能是启动项防护回滚（Windows 常见）
    return {
      tone: "warn",
      text: "系统里没找到麻薯的启动项，可能被安全软件拦下了。可以点「重新应用」再试一次。",
    };
  }
  if (desired && system.enabled) {
    return { tone: "ok", text: "已写入系统启动项，下次开机会自动打开麻薯。" };
  }
  if (!desired && system.enabled) {
    return {
      tone: "warn",
      text: "系统里还留着开机启动项（设置说关、系统说开）。点「重新应用」可以清理掉。",
    };
  }
  if (!desired && !system.enabled) {
    return { tone: "none", text: "" };
  }
  // 打开失败（ok=false）：把系统的原话附上，方便用户判断是权限还是被拦截
  return {
    tone: "warn",
    text: `没能写入开机启动项${system.error ? `：${system.error}` : "，请稍后重试。"}`,
  };
}
