import { describe, expect, it } from "vitest";
import { BUBBLE_MAX_CHARS, truncateForBubble } from "../bubble-text";

describe("truncateForBubble", () => {
  it("空串与纯空白返回空串", () => {
    expect(truncateForBubble("")).toBe("");
    expect(truncateForBubble("   \n\t ")).toBe("");
  });

  it("短文本原样返回（不去句读）", () => {
    expect(truncateForBubble("好呀，我在听～")).toBe("好呀，我在听～");
  });

  it("Markdown 换行与多空格压成单空格", () => {
    expect(truncateForBubble("第一行\n\n第二行  三个空格")).toBe("第一行 第二行 三个空格");
  });

  it("超长时按最后一个句读截断，保留完整句", () => {
    // 90 码点（10 × 9 字句）：前 60 内最后一个「。」在第 54 码点处
    const text = "这句话用来凑长度。".repeat(10);
    const out = truncateForBubble(text);
    expect(out.endsWith("。")).toBe(true);
    expect([...out]).toHaveLength(54);
  });

  it("无句读时硬截 60 码点并加省略号", () => {
    const text = "啊".repeat(80);
    const out = truncateForBubble(text);
    expect(out).toBe("啊".repeat(BUBBLE_MAX_CHARS) + "…");
  });

  it("emoji 按码点截断不产生乱码（代理对不被劈开）", () => {
    const text = "🍅".repeat(70); // 70 码点 = 140 个 UTF-16 单元
    const out = truncateForBubble(text);
    expect(out.endsWith("…")).toBe(true);
    expect([...out]).toHaveLength(BUBBLE_MAX_CHARS + 1); // 60 码点 + …
    expect([...out.slice(0, -1)].every(c => c === "🍅")).toBe(true);
  });

  it("句读太靠前（短于最小句长）时不采用，走硬截", () => {
    // 前 60 码点内唯一的句读在第 3 位（「好。」之后全是长句）
    const text = "好。" + "这个句子没有任何标点会一直延伸下去".repeat(5);
    const out = truncateForBubble(text);
    expect(out).not.toBe("好。");
    expect(out.endsWith("…")).toBe(true);
  });
});
