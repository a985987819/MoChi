/**
 * synonyms 查询扩展单测 —— 规格来源：docs/learning/05-rag-bm25.md §5.4。
 */
import { describe, expect, it } from "vitest";
import { expandQuery } from "../synonyms";

describe("expandQuery", () => {
  it("命中组内任一词则并入全组", () => {
    const q = expandQuery("巨无霸多少热量");
    expect(q).toContain("big mac");
    expect(q).toContain("千卡");
  });

  it("品牌口语归一（M记→麦当劳）", () => {
    expect(expandQuery("M记的薯条")).toContain("麦当劳");
  });

  it("不命中任何组时原样返回（小写化）", () => {
    expect(expandQuery("Pizza")).toBe("pizza");
  });

  it("幂等：扩展结果再扩展不再增长", () => {
    const once = expandQuery("肯德基 巨无霸");
    expect(expandQuery(once)).toBe(once);
  });
});
