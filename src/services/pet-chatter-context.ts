import { DEFAULT_ADDRESSING } from "@/shared/addressing";
import { loadSettings } from "@/services/settings";
import { petState } from "@/services/pet-state";
import { presenceService } from "@/services/presence";
import { pomodoroService } from "@/services/timers";
import type { ChatterContext } from "@/services/pet-chatter";

/**
 * 仅在确认单击后取当前快照：设置失败仍能离线说话；不发模型请求、改表情或重置计时。
 * 点击本身是恢复输入的信号，轮询尚未从 away 更新时也能欢迎回来，而不等待10秒。
 */
export async function loadChatterContext(): Promise<ChatterContext> {
  const names = await loadSettings().then(settings => ({
    petSelfName: settings.petSelfName, userNickname: settings.userNickname,
  })).catch(() => ({ ...DEFAULT_ADDRESSING }));
  const now = new Date();
  const activity = presenceService.activitySnapshot(now.getTime());
  const awayAtClick = presenceService.current === "away";
  return {
    now,
    petState: petState.current,
    phase: pomodoroService.status().phase,
    activeMinutes: awayAtClick ? 0 : activity.activeMinutes,
    recentlyReturned: awayAtClick || activity.recentlyReturned,
    names,
  };
}
