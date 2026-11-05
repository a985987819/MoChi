/**
 * 常驻服务的资源袋：注册中的异步监听如果晚于 dispose 完成，也会立刻解绑。
 * 把启动/退出竞态关在一处，避免热更新或失败重试累积多套监听和计时器。
 */
export class ServiceScope {
  active = true;
  private cleanups: Array<() => void> = [];

  /** 收纳异步注册返回的清理函数，初始化中途退出也不会泄漏。 */
  async add(registration: Promise<() => void>): Promise<void> {
    const off = await registration;
    if (this.active) this.cleanups.push(off);
    else off();
  }

  /** 幂等释放本轮启动的资源。 */
  dispose(): void {
    this.active = false;
    for (const off of this.cleanups.splice(0)) off();
  }
}
