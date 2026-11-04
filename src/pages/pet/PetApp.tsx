import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { petState, type PetState } from "@/services/pet-state";
import { listVariants, pickRandom, type PetVariant } from "@/services/pet-assets";
import { MochiPlaceholder } from "@/shared/components/MochiPlaceholder";
import { sendUIEvent, UI_EVENTS } from "@/shared/events";
import { ContextMenu } from "./ContextMenu";
import { PetGestureController } from "./gestures";
import { TimedBubble, type BubbleDisplay } from "./bubble-display";
import { PetBubble } from "./PetBubble";
import { PetChatter, type BubbleLine } from "@/services/pet-chatter";
import { loadChatterContext } from "@/services/pet-chatter-context";
import "./pet.css";

/**
 * 宠物窗（pet）—— v0.2.0：接入状态系统（素材渲染/变体轮换/自绘右键菜单）。
 *
 * 窗口特性（tauri.conf.json）：透明、无边框、置顶、220×260、跳过任务栏。
 *
 * 交互契约：
 * - 按住移动超过阈值：请求 Rust 拖动，避免按下就进入原生拖动吞掉双击；
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
 * 轮换定时器闭包内自递归；加载失败排除 URL 后重新解析，状态切换重新挂载并允许重试。
 */
function usePetAsset(state: PetState): { asset: PetVariant | null; onError(): void } {
  const [asset, setAsset] = useState<PetVariant | null>(null);
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(() => new Set());
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

    void listVariants(state, failedUrls).then(pool => {
      if (cancelled) return;
      const first = pickRandom(pool) ?? null;
      setAsset(first);
      if (first && !first.animated) scheduleRotate(pool, first);
    }).catch(() => {
      if (!cancelled) setAsset(null); // 异常路径也显示占位，避免未处理 Promise 和空白宠物
    });

    return () => {
      cancelled = true;
      if (rotateTimer.current != null) window.clearTimeout(rotateTimer.current);
    };
  }, [state, failedUrls]);

  const onError = useCallback(() => {
    if (!asset) return;
    setFailedUrls(previous => new Set([...previous, asset.url]));
    setAsset(null); // 立即呈现占位，再解析下一级素材，坏图不会永久停留
  }, [asset]);

  return { asset, onError };
}

/** 按状态重新挂载：失败 URL 只在本次显示会话内排除，用户替换文件后下次切换可重试。 */
function PetSprite({ state }: { state: PetState }) {
  const { asset, onError } = usePetAsset(state);
  return asset ? (
    <img className="pet-stage__img" src={asset.url} alt={state} draggable={false} onError={onError} />
  ) : <MochiPlaceholder />;
}

export function PetApp() {
  const state = usePetState();
  const [bouncing, setBouncing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [bubble, setBubble] = useState<BubbleDisplay<BubbleLine> | null>(null);
  const chatter = useMemo(() => new PetChatter(), []);
  const bubbleDisplay = useMemo(() => new TimedBubble<BubbleLine>(setBubble), []);

  useEffect(() => {
    bubbleDisplay.activate();
    return () => bubbleDisplay.dispose();
  }, [bubbleDisplay]);

  const gestures = useMemo(() => new PetGestureController({
    singleClick: () => {
      setBouncing(false);
      requestAnimationFrame(() => setBouncing(true));
      void sendUIEvent(UI_EVENTS.resetStandup).catch(error => console.error("[pet] 重置计时失败", error));
      void bubbleDisplay.showContext(loadChatterContext, context => chatter.next(context));
    },
    doubleClick: () => {
      bubbleDisplay.cancel();
      void sendUIEvent(UI_EVENTS.openChat).catch(error => console.error("[pet] 打开聊天失败", error));
    },
    drag: () => {
      bubbleDisplay.cancel();
      // 当前 pointermove 先释放 DOM capture，再让系统接管拖动。
      queueMicrotask(() => {
        void sendUIEvent(UI_EVENTS.dragPet).catch(error => console.error("[pet] 拖动失败", error));
      });
    },
  }), [bubbleDisplay, chatter]);

  useEffect(() => {
    const cancel = () => { gestures.cancel(); bubbleDisplay.cancel(); };
    const visibilityChanged = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibilityChanged);
      gestures.cancel();
    };
  }, [gestures, bubbleDisplay]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    gestures.cancel();
    bubbleDisplay.cancel();
    setMenu({ x: e.clientX, y: e.clientY });
  }, [gestures, bubbleDisplay]);

  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <main
      className={`pet-stage${bouncing ? " pet-stage--bounce" : ""}`}
      onPointerDown={e => {
        if (menu) { setMenu(null); gestures.cancel(); bubbleDisplay.cancel(); return; }
        gestures.pointerDown(e.pointerId, e.clientX, e.clientY, e.button);
        if (e.button === 0) e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        if (gestures.pointerMove(e.pointerId, e.clientX, e.clientY) && e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
      onPointerUp={e => {
        gestures.pointerUp(e.pointerId, e.clientX, e.clientY);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => gestures.cancel()}
      onContextMenu={handleContextMenu}
      onAnimationEnd={event => {
        if (event.animationName === "mochi-bounce") setBouncing(false);
      }}
    >
      <div className="pet-stage__pet">
        <PetSprite key={state} state={state} />
      </div>
      {bubble && <PetBubble key={bubble.sequence} text={bubble.line.text} leaving={bubble.leaving} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={closeMenu} />}
    </main>
  );
}
