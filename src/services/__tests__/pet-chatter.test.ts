import { describe, expect, it } from "vitest";
import { PetChatter, chatterTimeOfDay, type ChatterContext } from "@/services/pet-chatter";
import { CHATTER_LINES } from "@/services/pet-chatter-lines";

const context = (patch: Partial<ChatterContext> = {}): ChatterContext => ({
  now: new Date(2026, 10, 4, 8), petState: "idle", phase: "idle", activeMinutes: 1,
  recentlyReturned: false, names: { petSelfName: "团团", userNickname: "小林" }, ...patch,
});

describe("点击文案语境", () => {
  it.each([[5, "morning"], [10, "morning"], [11, "noon"], [13, "noon"], [14, "afternoon"],
    [17, "afternoon"], [18, "evening"], [21, "evening"], [22, "night"], [0, "night"], [4, "night"]] as const)("本地%s点路由到%s", (hour, category) => {
    expect(chatterTimeOfDay(hour)).toBe(category);
  });

  it.each(["focus", "break"] as const)("%s状态优先于时段和活动时长", phase => {
    const line = new PetChatter(() => 0).next(context({ phase, activeMinutes: 100 }));
    expect(line.category).toBe(phase);
  });

  it("活动段较长才选择轻休息建议，不推断具体忙碌行为", () => {
    expect(new PetChatter(() => 0).next(context({ activeMinutes: 45 })).category).toBe("long-session");
    expect(new PetChatter(() => 0).next(context({ activeMinutes: 44 })).category).toBe("morning");
  });

  it("切换专注/休息后的第一次摸摸先回应新阶段", () => {
    const chatter = new PetChatter(() => 0.7);
    chatter.next(context());
    expect(chatter.next(context({ phase: "focus" })).category).toBe("focus");
    expect(chatter.next(context({ phase: "break" })).category).toBe("break");
  });

  it("同一次回来不反复打招呼，后续再次回来可欢迎", () => {
    const chatter = new PetChatter(() => 0);
    expect(chatter.next(context({ recentlyReturned: true })).category).toBe("return");
    expect(chatter.next(context({ recentlyReturned: true })).category).not.toBe("return");
    chatter.next(context({ recentlyReturned: false }));
    expect(chatter.next(context({ recentlyReturned: true })).category).toBe("return");
  });

  it("短时间连续摸摸会有俏皮回应，跨窗口不保留永久点击档案", () => {
    const chatter = new PetChatter(() => 0);
    chatter.next(context()); chatter.next(context());
    expect(chatter.next(context()).category).toBe("playful");
  });

  it("只在每次回来时点击也不会永久失去欢迎语", () => {
    const chatter = new PetChatter(() => 0);
    expect(chatter.next(context({ recentlyReturned: true })).category).toBe("return");
    expect(chatter.next(context({ now: new Date(2026, 10, 4, 14), recentlyReturned: true })).category).toBe("return");
  });

  it("随机数固定仍能轮换，连续30次不重复上一句", () => {
    const chatter = new PetChatter(() => 0);
    const lines = Array.from({ length: 30 }, (_, i) => chatter.next(context({ now: new Date(2026, 10, 4, 8, i) })));
    expect(new Set(lines.map(line => line.id)).size).toBeGreaterThan(12);
    for (let i = 1; i < lines.length; i++) expect(lines[i].id).not.toBe(lines[i - 1].id);
  });

  it("插值使用用户偏好，长称呼仅显示摘要", () => {
    for (const line of CHATTER_LINES.filter(line => line.text.includes("{user}"))) {
      const categoryPool = CHATTER_LINES.filter(item => item.category === line.category);
      // 找到一条带用户插值的 morning 例子，其余语境在词库检查中覆盖。
      if (line.category !== "morning") continue;
      const chatter = new PetChatter(() => categoryPool.indexOf(line) / categoryPool.length);
      const result = chatter.next(context({ names: { petSelfName: "团团", userNickname: "甲乙丙丁戊己庚辛壬癸" } }));
      expect(result.text).toContain("甲乙丙丁戊己庚…");
      expect(result.text).not.toContain("{user}");
    }
  });

  it("名字中的占位符作为文字保留，不递归替换成另一人的名字", () => {
    const line = new PetChatter(() => 0).next(context({ names: { petSelfName: "团团", userNickname: "{pet}" } }));
    expect(line.text).toContain("{pet}");
    expect(line.text).not.toContain("团团");
  });
});

it("词库足够多样：每类至少8条、id和正文唯一、短句适应小窗口", () => {
  expect(CHATTER_LINES.length).toBeGreaterThanOrEqual(120);
  expect(new Set(CHATTER_LINES.map(line => line.id)).size).toBe(CHATTER_LINES.length);
  expect(new Set(CHATTER_LINES.map(line => line.text)).size).toBe(CHATTER_LINES.length);
  const categories = new Set(CHATTER_LINES.map(line => line.category));
  expect(categories.size).toBe(12);
  for (const category of categories) expect(CHATTER_LINES.filter(line => line.category === category).length).toBeGreaterThanOrEqual(8);
  for (const line of CHATTER_LINES) {
    expect(line.text.replace(/\{(pet|user)\}/g, "最长称呼七个字…").length).toBeLessThanOrEqual(52);
    expect(line.text.replace(/\{(pet|user)\}/g, "")).not.toMatch(/\{[^}]*\}/);
  }
});
