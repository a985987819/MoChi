import { useCallback, useEffect, useRef, useState } from "react";
import { petState, type PetState } from "@/services/pet-state";
import { listVariants, pickRandom, type PetVariant } from "@/services/pet-assets";
import { MochiPlaceholder } from "@/shared/components/MochiPlaceholder";
import { sendUIEvent, UI_EVENTS } from "@/shared/events";
import { ContextMenu } from "./ContextMenu";
import "./pet.css";

/**
 * 宠物窗（pet）—— v0.2.0：接入状态系统（素材渲染/变体轮换/自绘右键菜单）。
 *
 * 窗口特性（tauri.conf.json）：透明、无边框、置顶、220×260、跳过任务栏。
 *
 * 交互契约：
 * - 按住拖动：舞台整体是 Tauri 拖动区（data-tauri-drag-region）；
 * - 单击：弹跳动画 + emit `ui://reset-standup`（v0.7.0 Rust 接站立计时重置）；
 * - 双击：打开聊天窗；右键：自绘菜单（ContextMenu.tsx）。
 *
 * 架构分工（v0.2.0 起固定）：
 * - PetStateManager（services/pet-state.ts）：只做状态仲裁（槽位/优先级/超时）；
 * - 本组件：状态 → 素材的**展示**，含变体轮换；
 * - 素材解析（services/pet-assets.ts）：回退链 用户目录 > 内置 > 占位 SVG。
 */

/** 订阅状态仲裁结果 */
function usePetState(): PetState {
  const [state, setState] = useState<PetState>(petState.current);
  useEffect(() => petState.subscribe(setState), []);
  return state;
}

/**
 * 状态 → 素材展示：进入新状态时解析变体池并随机取一张；
 * 若取到静态图且池内有多张静态图，每 5~9 秒随机轮换；动画图（gif/webp）播到天荒地老不轮换。
 * 依赖数组只有 state：轮换定时器闭包内自递归，状态切换即整体重置。
 */
function usePetAsset(state: PetState): PetVariant | null {
  const [asset, setAsset] = useState<PetVariant | null>(null);
  const rotateTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const scheduleRotate = (pool: PetVariant[], current: PetVariant) => {
      const statics = pool.filter(v => !v.animated);
      if (statics.length <= 1) return; // 单一静态图 / 动画图：不轮换
      const delay = 5000 + Math.random() * 4000;
      rotateTimer.current = window.setTimeout(() => {
        if (cancelled) return;
        // 排除当前这张，保证轮换"看得见"
        const candidates = statics.filter(v => v.url !== current.url);
        const next = pickRandom(candidates) ?? current;
        setAsset(next);
        scheduleRotate(pool, next);
      }, delay);
    };

    void listVariants(state).then(pool => {
      if (cancelled) return;
      const first = pickRandom(pool) ?? null;
      setAsset(first);
      if (first && !first.animated) scheduleRotate(pool, first);
    });

    return () => {
      cancelled = true;
      if (rotateTimer.current != null) window.clearTimeout(rotateTimer.current);
    };
  }, [state]);

  return asset;
}

export function PetApp() {
  const state = usePetState();
  const asset = usePetAsset(state);
  const [bouncing, setBouncing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const handleClick = useCallback(() => {
    // 弹跳（即时反馈）+ 重置站立计时（事件契约先立，Rust v0.7.0 接 StandupService）
    setBouncing(false);
    requestAnimationFrame(() => setBouncing(true));
    void sendUIEvent(UI_EVENTS.resetStandup);
  }, []);

  const handleDoubleClick = useCallback(() => {
    void sendUIEvent(UI_EVENTS.openChat);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

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
        {asset ? (
          <img className="pet-stage__img" src={asset.url} alt={state} draggable={false} />
        ) : (
          <MochiPlaceholder />
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={closeMenu} />}
    </main>
  );
}
