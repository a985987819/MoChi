import { useCallback, useState } from "react";
import { MochiPlaceholder } from "@/shared/components/MochiPlaceholder";
import { sendUIEvent, UI_EVENTS } from "@/shared/events";
import "./pet.css";

/**
 * 宠物窗（pet）—— v0.1.0 骨架版。
 *
 * 窗口特性（由 tauri.conf.json 声明）：透明、无边框、置顶、跳过任务栏、固定 220×260。
 *
 * 交互约定（v0.1.0 范围）：
 * - 按住拖动：整个舞台是 Tauri 拖动区（data-tauri-drag-region，左键按住即可拖）；
 * - 单击：小弹跳动画（v0.7.0 时同一交互将接入「重置站立计时」）；
 * - 双击：打开聊天窗（emit `ui://open-chat`，Rust 侧负责 show + focus）；
 * - 右键：暂不响应（v0.2.0 做自绘右键菜单）。
 *
 * 待办预告：v0.2.0 起 MochiPlaceholder 会被 PetStateManager 的素材渲染器替代。
 */
export function PetApp() {
  const [bouncing, setBouncing] = useState(false);

  const handleClick = useCallback(() => {
    // 重复点击时先复位再触发，保证动画能重新播放
    setBouncing(false);
    requestAnimationFrame(() => setBouncing(true));
  }, []);

  const handleDoubleClick = useCallback(() => {
    void sendUIEvent(UI_EVENTS.openChat);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    // 屏蔽 WebView 默认右键菜单；v0.2.0 换成自绘菜单
    e.preventDefault();
  }, []);

  return (
    <main
      className={`pet-stage${bouncing ? " pet-stage--bounce" : ""}`}
      data-tauri-drag-region
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onAnimationEnd={() => setBouncing(false)}
    >
      <div className="pet-stage__pet" data-tauri-drag-region>
        <MochiPlaceholder />
      </div>
    </main>
  );
}
