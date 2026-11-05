/** 注入用户动作，让指针时序独立于 React/原生窗口，便于复现拖动和双击的竞争。 */
export interface PetGestureActions {
  singleClick(): void;
  doubleClick(): void;
  drag(): void;
  /**
   * 纯视觉的即时点击反馈（v0.9.0 手感优化）：抬指瞬间触发，不等双击判定。
   * singleClick 里的语义副作用（重置站立计时/暖心气泡）必须等 500ms 判定窗口
   * 结束——否则双击会被拆成两次"重置计时"。但弹跳这类零副作用的视觉反馈
   * 没有理由陪判：点击到弹跳的延迟就是用户感知到的"掉帧/不跟手"。
   * 可选注入：既有测试与调用方不受影响。
   */
  clickFeedback?(): void;
}

interface Point { pointerId: number; x: number; y: number }
const DRAG_DISTANCE = 5;
const DOUBLE_CLICK_MS = 500;

/**
 * 一次指针序列只产生一种动作：移动超过阈值即交给原生拖动；否则抬起后等待双击窗口。
 * 不再同时消费 click/dblclick，因此双击不会顺带重置两次站立计时，拖动也不会被当成单击。
 */
export class PetGestureController {
  private pressed: Point | null = null;
  private pending: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly actions: PetGestureActions) {}

  /** 只记录左键；右键及触摸取消不进入单击计时。 */
  pointerDown(pointerId: number, x: number, y: number, button: number): void {
    if (button !== 0) return;
    this.pressed = { pointerId, x, y };
  }

  /** 返回是否开始拖动，调用方可在交出窗口控制前释放浏览器指针捕获。 */
  pointerMove(pointerId: number, x: number, y: number): boolean {
    const start = this.pressed;
    if (!start || start.pointerId !== pointerId || Math.hypot(x - start.x, y - start.y) < DRAG_DISTANCE) return false;
    this.cancel();
    this.actions.drag();
    return true;
  }

  /**
   * 小幅抖动算单击；同位置短时间内第二次抬起算双击，仅执行打开聊天。
   * 每一次"未成为拖动"的抬指都先触发 clickFeedback（纯视觉即时反馈），
   * 语义动作再按双击判定结果分发。
   */
  pointerUp(pointerId: number, x: number, y: number): void {
    const start = this.pressed;
    this.pressed = null;
    if (!start || start.pointerId !== pointerId) return;
    if (Math.hypot(x - start.x, y - start.y) >= DRAG_DISTANCE) {
      this.clearPending();
      return;
    }
    this.actions.clickFeedback?.();
    if (this.pending) {
      const sameSpot = Math.hypot(x - this.pending.x, y - this.pending.y) < DRAG_DISTANCE;
      this.clearPending();
      if (sameSpot) { this.actions.doubleClick(); return; }
      this.actions.singleClick();
    }
    this.pending = {
      x, y,
      timer: setTimeout(() => {
        this.pending = null;
        this.actions.singleClick();
      }, DOUBLE_CLICK_MS),
    };
  }

  /** 菜单打开、窗口失焦或组件卸载时取消未决动作，避免隐藏后才触发点击。 */
  cancel(): void {
    this.pressed = null;
    this.clearPending();
  }

  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}
