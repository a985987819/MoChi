import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({
  settings: vi.fn(), phase: "idle", state: "idle", presence: "active",
  activity: { activeMinutes: 48, recentlyReturned: false },
}));
vi.mock("@/services/settings", () => ({ loadSettings: deps.settings }));
vi.mock("@/services/timers", () => ({ pomodoroService: { status: () => ({ phase: deps.phase }) } }));
vi.mock("@/services/pet-state", () => ({ petState: { get current() { return deps.state; } } }));
vi.mock("@/services/presence", () => ({ presenceService: {
  get current() { return deps.presence; }, activitySnapshot: () => deps.activity,
} }));
import { loadChatterContext } from "@/services/pet-chatter-context";
beforeEach(() => {
  deps.settings.mockReset().mockResolvedValue({ petSelfName: "团团", userNickname: "小林" });
  deps.presence = "active"; deps.phase = "idle";
});

it("只读取快照并带入最新称呼及番茄钟语境", async () => {
  deps.phase = "focus";
  expect(await loadChatterContext()).toMatchObject({ phase: "focus", activeMinutes: 48, names: { petSelfName: "团团", userNickname: "小林" } });
});
it("轮询仍是away时点击可欢迎回来，不改全局presence", async () => {
  deps.presence = "away";
  expect(await loadChatterContext()).toMatchObject({ activeMinutes: 0, recentlyReturned: true });
  expect(deps.presence).toBe("away");
});
it("设置暂时不可读仍能用默认称呼说话", async () => {
  deps.settings.mockRejectedValue(new Error("临时不可用"));
  expect((await loadChatterContext()).names).toEqual({ petSelfName: "麻薯", userNickname: "人" });
});
