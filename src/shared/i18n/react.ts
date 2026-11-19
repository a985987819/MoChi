/**
 * i18n 的 React 接口 —— useT()（P2-03B / v0.19.0）。
 *
 * useSyncExternalStore 是 React 18 订阅外部状态的正规姿势：locale 变化触发
 * 重渲染（切换语言不需要重启的另一半——字典在模块里，组件重渲染即换文案）。
 * t 函数按 locale 记忆，引用稳定不破坏子组件的 memo。
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { getLocale, getRevision, subscribeLocale, t, type Locale } from "./core";
import type { MessageKey } from "./zh-CN";

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function useT(): { t: Translate; locale: Locale } {
  // 快照用 revision：语言或宠物自称变化都会重渲染（t 文案里的 {pet} 才会即时更新）
  const revision = useSyncExternalStore(subscribeLocale, getRevision);
  const translate = useCallback<Translate>(
    (key, vars) => t(key, vars),
    [revision], // revision 变化换一个引用，强制消费 t 的组件重渲染
  );
  return useMemo(() => ({ t: translate, locale: getLocale() }), [translate, revision]);
}
