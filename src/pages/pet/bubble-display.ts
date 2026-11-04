/** 一次气泡展示的快照；sequence 供 React 重新播放入场动画，文本 id 不能替代点击序号。 */
export interface BubbleDisplay<T> {
  sequence: number;
  line: T;
  leaving: boolean;
}

/**
 * 展示计时独立于 React 与文案选择：旧的异步上下文、旧的收尾定时器都不能覆盖新点击。
 * 普通展示 7 秒、离场 200ms；菜单/拖动/双击可同步撤回并使在途请求失效。
 */
export class TimedBubble<T> {
  private sequence = 0;
  private active = true;
  private timers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(private readonly onChange: (display: BubbleDisplay<T> | null) => void) {}

  /** effect 重挂载时重新启用，兼容 React 开发模式的清理/重建。 */
  activate(): void { this.active = true; }

  /** 只有最近一次、且未被撤回的加载成功后才呈现；加载失败不影响原本的宠物动作。 */
  show(load: () => Promise<T>): Promise<void> {
    return this.showContext(load, line => line);
  }

  /** 先校验请求仍有效，再消费有去重/欢迎记录的选择器，取消点击不消耗文案。 */
  async showContext<C>(load: () => Promise<C>, select: (context: C) => T): Promise<void> {
    this.clearTimers();
    const sequence = ++this.sequence;
    if (!this.active) return;
    this.onChange(null);
    try {
      const context = await load();
      if (!this.active || sequence !== this.sequence) return;
      const line = select(context);
      this.onChange({ sequence, line, leaving: false });
      this.timers.push(setTimeout(() => {
        if (!this.active || sequence !== this.sequence) return;
        this.onChange({ sequence, line, leaving: true });
        this.timers.push(setTimeout(() => {
          if (this.active && sequence === this.sequence) this.onChange(null);
        }, 200));
      }, 7000));
    } catch {
      // 配置短暂不可读时放弃这一条，既不制造未处理拒绝，也不显示编造的上下文。
    }
  }

  /** 撤回当前内容并作废仍在等待的请求，避免菜单打开后旧气泡才出现。 */
  cancel(): void {
    this.sequence += 1;
    this.clearTimers();
    if (this.active) this.onChange(null);
  }

  /** 卸载时不再写 React state，晚到的 Promise 也只能被忽略。 */
  dispose(): void {
    this.sequence += 1;
    this.active = false;
    this.clearTimers();
  }

  private clearTimers(): void {
    for (const timer of this.timers.splice(0)) clearTimeout(timer);
  }
}
