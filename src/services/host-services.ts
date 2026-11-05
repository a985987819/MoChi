import { subscribeHeartbeat } from "@/services/heartbeat";

/** 业务服务只暴露生命周期，监督器不依赖具体计时或存储实现。 */
export interface HostedService { start(): Promise<void>; dispose(): void; }

/**
 * 各服务独立启动：设置/数据库暂时失败不会阻止其他功能。
 * 初始化失败每五秒重试；同一服务最多一个启动在途，HMR 退出会停止全部资源。
 */
export async function hostServices(services: HostedService[]): Promise<() => void> {
  let stopped = false;
  const states = services.map(service => ({ service, ready: false, starting: false, retryAt: 0 }));
  const check = () => {
    for (const state of states) {
      if (stopped || state.ready || state.starting || Date.now() < state.retryAt) continue;
      state.starting = true;
      void Promise.resolve().then(() => state.service.start()).then(() => {
        state.ready = true;
        if (stopped) state.service.dispose();
      }).catch(() => { state.retryAt = Date.now() + 5000; })
        .finally(() => { state.starting = false; });
    }
  };
  check();
  const off = await subscribeHeartbeat(check);
  return () => {
    stopped = true;
    off();
    for (const { service } of states) service.dispose();
  };
}
