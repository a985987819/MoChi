/**
 * 错误文案映射（v0.9.0 P1-07）——把 (kind, message) 翻译成「人话 + 下一步」。
 *
 * 旧渲染：`[bad-request] 参数无效`——用户看到内部枚举，不知道该做什么。
 * 新渲染：一句话说清发生了什么 + 一个可点的动作按钮（去设置/重试/稍后再试）；
 * 原始 message 收进可展开的详情（排查用，默认折叠）。
 *
 * 为什么放 agent/ 而不是 pages/：错误分类是 Provider 协议层的知识（02 §4.3），
 * 与 UI 框架无关——本文件零 React/tauri 依赖，可直接单测；
 * 页面层只负责把 action 渲染成按钮。
 *
 * 文案规范（施工单附录 B）：说人话、给下一步、单行 ≤28 汉字、不堆感叹号。
 */

import type { ProviderError, ProviderErrorKind } from "./providers/types";

/** 错误条上用户可以点的下一步 */
export type ErrorAction = "settings" | "retry" | "dismiss";

export interface FriendlyError {
  /** 一句话主文案（已含"发生了什么"） */
  headline: string;
  /** 建议动作（渲染成按钮；none = 只有关闭） */
  action: ErrorAction;
  /** 动作按钮文案 */
  actionLabel: string;
}

const KIND_TEXT: Record<ProviderErrorKind, FriendlyError> = {
  auth: {
    headline: "Key 好像不对，麻薯连不上服务",
    action: "settings",
    actionLabel: "去设置检查",
  },
  "rate-limit": {
    headline: "请求太频繁，被服务限流了",
    action: "retry",
    actionLabel: "稍后重试",
  },
  server: {
    headline: "服务那边开小差了，不是你的问题",
    action: "retry",
    actionLabel: "重试",
  },
  network: {
    headline: "网络不通，检查一下连接再试",
    action: "retry",
    actionLabel: "重试",
  },
  "bad-request": {
    // 400/422 通常是参数/协议问题：用户侧能做的只有换模型或报 issue
    headline: "这次请求没成功，可能是模型或参数不支持",
    action: "settings",
    actionLabel: "去设置换模型",
  },
  aborted: {
    // 用户主动停止不是"错误"：中性一句话，无需动作
    headline: "已停止这个回复",
    action: "dismiss",
    actionLabel: "知道了",
  },
};

/** (kind, message) → 人话错误；未知 kind 兜底为通用网络话术（不抛错） */
export function toFriendlyError(error: ProviderError): FriendlyError {
  return KIND_TEXT[error.kind] ?? KIND_TEXT.network;
}
