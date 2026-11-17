/**
 * 前端日志上报（P2-01 / v0.16.0）—— 与 Rust 写**同一个**日志文件。
 *
 * # 为什么前端也要落盘
 *
 * release 没有控制台，前端异常（IPC 失败、SQLite 被锁、素材加载失败）原本只有
 * console——在打包版里同样丢失。统一走 Rust 的 `append_log` 命令：一个目录、
 * 一套轮转、一处排障。
 *
 * # 铁律：日志不能反过来制造错误
 *
 * 所有上报**失败静默**（`catch(() => undefined)`）——日志写入失败再抛错，会把
 * "排障手段"变成"新的故障源"。因此全部 fire-and-forget，不返回 Promise。
 *
 * # 脱敏纪律（AGENTS.md / learning/08 §3）
 *
 * `redact` 是最后一道防线：sk- 形态 Key、Bearer 令牌打码、超长截断。但脱敏
 * 不是写正文的许可证——调用方消息只写"发生了什么 + 长度/计数"（如
 * `提醒扫描失败: ${error}` 可以，`${reminder.text}` 不行），聊天/提醒正文、
 * 窗口标题/进程名一律不进日志。
 */

import { invoke } from "@tauri-apps/api/core";

/** 单条消息字符上限：与 Rust 侧 LOG_MESSAGE_MAX_CHARS 同一纪律（双端各截一次） */
const MESSAGE_MAX_CHARS = 800;

/**
 * 脱敏纯函数（单测覆盖）：
 * - `sk-` 前缀密钥打码（≥6 位 token 才算 Key 形态，避免误伤 "task-skill" 这类词）；
 * - `Bearer` 令牌打码；
 * - 超长按字符截断并留提示。
 */
export function redact(message: string): string {
  const masked = message
    // 词边界：(?<![A-Za-z0-9_-]) 防止 task-skill 里的 "sk-" 被当成密钥前缀
    .replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(/(?<![A-Za-z0-9_-])Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***");
  if (masked.length > MESSAGE_MAX_CHARS) {
    return `${masked.slice(0, MESSAGE_MAX_CHARS)}…（截断）`;
  }
  return masked;
}

type Level = "error" | "warn" | "info";

function report(level: Level, scope: string, message: string): void {
  void invoke("append_log", { level, scope, message: redact(message) }).catch(() => undefined);
}

/** 错误：调用失败/数据异常——排障的主要来源 */
export function logError(scope: string, message: string): void {
  report("error", scope, message);
}

/** 警告：功能降级但仍可用（快捷键被占用、图标缺失……） */
export function logWarn(scope: string, message: string): void {
  report("warn", scope, message);
}

/** 信息：关键生命周期事件（极少用——日志只记异常与降级，不记流水） */
export function logInfo(scope: string, message: string): void {
  report("info", scope, message);
}

/**
 * 全局兜底（v0.16.0）：未捕获的 JS 异常与 Promise 拒绝也进日志。
 * 在各窗口入口（pet/chat main.tsx）调用一次；alert 窗生命周期极短且只渲染
 * 单条提醒，不装。错误文本经 redact 截断——异常里可能带着业务片段，这是
 * "能排障"与"不存正文"的折中（800 字符内、打码后落盘）。
 */
export function installGlobalErrorLogging(scope: string): void {
  // 环境 guard：非浏览器环境（极端 WebView 状态/测试）不装——兜底不能自己先炸
  if (typeof window === "undefined") return;
  window.addEventListener("error", event => {
    report("error", scope, `未捕获异常: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", event => {
    report("error", scope, `未处理的 Promise 拒绝: ${String(event.reason)}`);
  });
}
