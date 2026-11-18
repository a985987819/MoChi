/**
 * 桌面操作工具（v0.28.0）—— "完整的 agent"的常规操作面：打开网页 / 打开数据目录。
 *
 * # 边界（learning/07 §6.3 自查）
 *
 * - 意图层归 Agent（"打开 xx 网站"是用户意图），执行层走应用 Service：
 *   opener 插件已在 capability 内（设置页外链/数据目录入口都在用），零新增权限；
 * - open_url 只接受 http/https——file:///javascript: 等协议一律拒绝
 *   （插件层还有一道 scheme 校验，双保险）；
 * - open_data_folder 打开的是应用**自己的**数据目录，不是任意路径——
 *   任意路径浏览是文件管理器的事，不是桌宠的事。
 */

import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { appDataDir } from "@tauri-apps/api/path";
import type { ToolDefinition } from "./registry";

/** 只允许 http/https（纯函数，可测）：file:/javascript:/内网协议一律拒绝 */
export function validateHttpUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  return trimmed;
}

export function openUrlTool(): ToolDefinition<{ url: string }> {
  return {
    name: "open_url",
    description:
      "用系统浏览器打开网页。用户说'打开 xx 网站/文档/官网'时使用；只支持 http/https 链接。" +
      "打开后告诉用户浏览器已弹出即可。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整的 http/https 网址（如 https://platform.deepseek.com）" },
      },
      required: ["url"],
    },
    risk: "write",
    async execute(args) {
      const url = validateHttpUrl(args.url);
      if (!url) return { ok: false as const, error: `只支持 http/https 网址，收到 "${args.url}"` };
      try {
        await openUrl(url);
      } catch (e) {
        return { ok: false as const, error: `浏览器打开失败: ${String(e)}（可让用户手动复制网址访问）` };
      }
      return { ok: true as const, data: { url, message: "已在系统浏览器打开" } };
    },
  };
}

export function openDataFolderTool(): ToolDefinition<Record<string, never>> {
  return {
    name: "open_data_folder",
    description:
      "打开 Mochi 的应用数据目录（聊天记录、设置、宠物素材都在这里）。" +
      "用户说'打开数据目录/我要备份/看看素材文件夹'时使用。",
    parameters: { type: "object", properties: {} },
    risk: "write",
    async execute() {
      const dir = await appDataDir();
      await revealItemInDir(dir);
      return { ok: true as const, data: { dir, message: "已在文件管理器中定位数据目录" } };
    },
  };
}
