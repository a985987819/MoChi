/** 输入的原始手势信息：双击后半次和键盘长按不属于一次新的确认意图。 */
export interface AlertAction {
  clickCount?: number;
  repeat?: boolean;
}

/**
 * React state 不会同步写入，不能拿 pending 当并发锁。
 * 这道同步门在原生队头切换后仍保留短暂冷却，避免同一次双击把下一条也确认。
 */
export class AlertActionGate {
  private inFlight = false;
  private acceptedAt = Number.NEGATIVE_INFINITY;

  constructor(private now: () => number = Date.now, private cooldownMs = 500) {}

  /** 只有一次独立手势、无正在执行的确认且冷却结束时才能取得确认权。 */
  tryBegin(action: AlertAction = {}): boolean {
    if (action.repeat || (action.clickCount ?? 1) > 1 || this.inFlight) return false;
    const now = this.now();
    if (now - this.acceptedAt < this.cooldownMs) return false;
    this.inFlight = true;
    this.acceptedAt = now;
    return true;
  }

  /** 仅释放执行锁，保留手势冷却；显示下一条提醒也不能清除冷却。 */
  finish(): void {
    this.inFlight = false;
  }
}
