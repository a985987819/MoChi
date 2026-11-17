import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { petState, type PetState } from "@/services/pet-state";
import { listVariants, pickRandom, type PetVariant } from "@/services/pet-assets";
import { loadSettings } from "@/services/settings";
import { playClick } from "@/services/sound";
import { MochiPlaceholder } from "@/shared/components/MochiPlaceholder";
import { playShowTransition, onWindowShown } from "@/shared/show-transition";
import { sendUIEvent, STATE_EVENTS, UI_EVENTS } from "@/shared/events";
import { ContextMenu } from "./ContextMenu";
import { PetGestureController } from "./gestures";
import { TimedBubble, type BubbleDisplay } from "./bubble-display";
import { PetBubble } from "./PetBubble";
import { PetChatter } from "@/services/pet-chatter";
import { loadChatterContext } from "@/services/pet-chatter-context";
import "./pet.css";

/**
 * 宠物窗（pet）—— v0.2.0：接入状态系统（素材渲染/变体轮换/自绘右键菜单）。
 *
 * 窗口特性（tauri.conf.json）：透明、无边框、置顶、220×260、跳过任务栏。
 *
 * 交互契约（v0.8.2 手势系统）：
 * - 按住移动超过阈值：请求 Rust 原生拖动，避免按下就进入原生拖动吞掉双击；
 * - 单击：弹跳动画 + 重置站立计时 + 头顶暖心气泡（语境选句，离线词库）；
 * - 双击：打开聊天窗；右键：自绘菜单（ContextMenu.tsx）。
 *
 * 气泡（合并说明，v0.9.0）：P1-01 的「Agent 回复气泡」与 v0.8.2 的「单击暖心气泡」
 * 统一为同一个 PetBubble 组件——都是"宠物头顶的非模态气泡"，共用入场/离场动画与
 * "最新一条覆盖上一条"的展示状态机。独立 bubble 窗（bubble.html）已删除：
 * 少一个 WebView 进程、少一条 Rust 转发链、少一份 capability，Agent 回复时
 * 宠物窗自己监听 ui://show-bubble 即可。
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
 * 帧序列播放间隔（v0.10.0）：150ms ≈ 6.7fps。桌宠的"呼吸感"比流畅度重要——
 * 常见 8~12 帧的待机动画在这个节奏下约 1.2~1.8 秒一轮，接近手绘 GIF 的观感。
 * 不做按状态差异化提速：目前没有可信的真机手感数据，先给一个稳妥值。
 */
const FRAME_INTERVAL_MS = 150;

/**
 * 帧序列播放：把 `asset.frames` 循环成当前帧 URL。
 *
 * 两个细节：
 * 1. **预加载所有帧**：`<img src>` 首次切到未缓存的 URL 会闪一下，而宠物窗是透明背景，
 *    闪白非常显眼；提前 `new Image()` 让切换走缓存。
 * 2. **依赖用拼接串**：`frames` 数组每次解析都是新引用，直接进依赖数组会让计时器
 *    在每个渲染周期被重置（动画永远停在第一帧）。
 */
function useFrameUrl(asset: PetVariant | null): string | null {
  const [index, setIndex] = useState(0);
  const frames = asset?.frames;
  const frameKey = frames?.join("|") ?? "";

  useEffect(() => {
    setIndex(0);
    if (!frames || frames.length < 2) return;
    for (const url of frames) {
      const preload = new Image();
      preload.src = url;
    }
    const timer = window.setInterval(() => {
      setIndex(previous => (previous + 1) % frames.length);
    }, FRAME_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // frameKey 是 frames 的内容摘要：数组引用会变，内容不变时不该重启计时器
  }, [frameKey]);

  if (!asset) return null;
  if (!frames || frames.length < 2) return asset.url;
  return frames[Math.min(index, frames.length - 1)];
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
      const statics = pool.filter(v => !v.animated && !(v.frames && v.frames.length > 1));
      if (statics.length <= 1) return; // 单一静态图 / 动画图 / 帧序列：都不轮换
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
      if (first && !first.animated && !(first.frames && first.frames.length > 1)) scheduleRotate(pool, first);
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
  const frameUrl = useFrameUrl(asset);
  return frameUrl ? (
    <img className="pet-stage__img" src={frameUrl} alt={state} draggable={false} onError={onError} />
  ) : <MochiPlaceholder />;
}

/** 气泡展示只需要文本；暖心句与 Agent 摘要共用同一渲染与计时。 */
type PetBubbleLine = { text: string };

export function PetApp() {
  const state = usePetState();
  const [bouncing, setBouncing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [gripping, setGripping] = useState(false);
  const [bubble, setBubble] = useState<BubbleDisplay<PetBubbleLine> | null>(null);
  const shellRef = useRef<HTMLElement>(null);
  const spriteRef = useRef<HTMLDivElement>(null);
  /** 当前是否已置穿透（与 Rust 状态同步；JS 在 ignore=true 后失明，靠 Rust 轮询唤回） */
  const passThroughRef = useRef(false);
  const chatter = useMemo(() => new PetChatter(), []);
  const bubbleDisplay = useMemo(() => new TimedBubble<PetBubbleLine>(setBubble), []);

  useEffect(() => {
    bubbleDisplay.activate();
    return () => bubbleDisplay.dispose();
  }, [bubbleDisplay]);

  // 拖拽握持反馈（Rust 边界广播：开始/结束各一次）：
  // 握持 = 暂停漂浮 + 微放大（"被拿在手里"），放下 = 回落（scale 过渡回落即动画）。
  // 拖拽期间窗口移动由 OS 合成器完成，暂停动画让形象不与手"打架"——这是拖拽
  // 不掉帧观感的另一半（前一半是 start_dragging 本身走 OS 原生拖动循环）。
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen<{ dragging?: unknown }>(STATE_EVENTS.petDragChanged, e => {
      setGripping(e.payload?.dragging === true);
    }).then(unlisten => {
      off = unlisten;
    });
    return () => off?.();
  }, []);

  // 窗口唤回（托盘切换/退出隐藏）时的轻过渡：淡入+上浮 160ms。
  // 硬切闪现会显得"系统卡了一下"；合成器动画不产生任何布局成本。
  useEffect(() => onWindowShown(() => playShowTransition(shellRef.current)), []);

  // 宠物大小（P1-15）：档位写进 CSS 变量缩放形象（窗口尺寸由 Rust 改）。
  // 启动读一次设置 + 监听变更，两个来源汇到同一个变量
  useEffect(() => {
    const apply = (scale: number) => document.documentElement.style.setProperty("--pet-scale", String(scale));
    void loadSettings().then(s => apply(s.petScale)).catch(() => undefined);
    let off: (() => void) | undefined;
    void listen<{ scale: number }>(STATE_EVENTS.petScaleChanged, e => {
      if (typeof e.payload?.scale === "number") apply(e.payload.scale);
    }).then(unlisten => {
      off = unlisten;
    });
    return () => off?.();
  }, []);

  // Agent 回复气泡（P1-01）：聊天窗在「回复完成且用户没看着聊天窗」时 emit
  // ui://show-bubble（载荷=截断后的摘要文本），宠物窗在此消费。
  // show() 的竞态保护保证：晚到的旧回复不能覆盖更新的气泡/点击。
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen<unknown>(UI_EVENTS.showBubble, e => {
      const text = typeof e.payload === "string" ? e.payload.trim() : "";
      if (!text) return;
      void bubbleDisplay.show(async () => ({ text }));
    }).then(unlisten => {
      off = unlisten;
    });
    return () => off?.();
  }, [bubbleDisplay]);

  const gestures = useMemo(() => new PetGestureController({
    // 即时视觉反馈（抬指即弹）：0 延迟的"按下去了"确认——感知流畅度的关键。
    // 弹跳零副作用，双击时多弹一次无碍；语义动作仍在 singleClick 等判定。
    // 音效（v0.12.0）与弹跳同属"即时反馈"，不等 500ms 双击判定：听着就该是按下即有。
    clickFeedback: () => {
      playClick();
      setBouncing(false);
      requestAnimationFrame(() => setBouncing(true));
    },
    singleClick: () => {
      void sendUIEvent(UI_EVENTS.resetStandup).catch(error => console.error("[pet] 重置计时失败", error));
      void bubbleDisplay.showContext(loadChatterContext, context => ({ text: chatter.next(context).text }));
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

  // 透明区域点击穿透（v0.9.0 桌宠体检）：宠物窗矩形大部分是透明的，却挡住
  // 底下窗口的点击（右下角正是托盘/开始菜单高频区）。方案：指针移动时做
  // 形象命中检测——形象外 → Rust set_ignore_cursor_events(true)（事件穿透到
  // 下一层窗口）；此后 WebView"失明"，Rust 150ms 轮询光标在重新进入形象矩形时唤回。
  // 菜单展开期间强制不穿透（菜单可能伸到形象矩形之外）。
  const updateHitTest = useCallback((x: number, y: number) => {
    if (menu) {
      if (passThroughRef.current) {
        passThroughRef.current = false;
        void invoke("set_pet_hit_test", { ignore: false, x: 0, y: 0, width: 0, height: 0 }).catch(() => undefined);
      }
      return;
    }
    const rect = spriteRef.current?.getBoundingClientRect();
    if (!rect) return;
    const inside = x >= rect.left - 8 && x <= rect.right + 8 && y >= rect.top - 8 && y <= rect.bottom + 8;
    if (inside && passThroughRef.current) {
      passThroughRef.current = false;
      void invoke("set_pet_hit_test", { ignore: false, x: 0, y: 0, width: 0, height: 0 }).catch(() => undefined);
    } else if (!inside && !passThroughRef.current) {
      passThroughRef.current = true;
      void invoke("set_pet_hit_test", {
        ignore: true,
        x: rect.left, y: rect.top, width: rect.width, height: rect.height,
      }).catch(() => undefined);
    }
  }, [menu]);

  // 菜单开合本身也要立即纠正穿透态（开菜单那一刻指针可能在形象外）
  useEffect(() => {
    if (menu) {
      passThroughRef.current = false;
      void invoke("set_pet_hit_test", { ignore: false, x: 0, y: 0, width: 0, height: 0 }).catch(() => undefined);
    }
  }, [menu]);

  return (
    <main
      ref={shellRef}
      className={`pet-stage${bouncing ? " pet-stage--bounce" : ""}${gripping ? " pet-stage--gripping" : ""}`}
      onPointerDown={e => {
        if (menu) { setMenu(null); gestures.cancel(); bubbleDisplay.cancel(); return; }
        gestures.pointerDown(e.pointerId, e.clientX, e.clientY, e.button);
        if (e.button === 0) e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        updateHitTest(e.clientX, e.clientY);
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
      <div className="pet-stage__pet" ref={spriteRef}>
        <PetSprite key={state} state={state} />
      </div>
      {bubble && <PetBubble key={bubble.sequence} text={bubble.line.text} leaving={bubble.leaving} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={closeMenu} />}
    </main>
  );
}
