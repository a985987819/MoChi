import { describe, expect, it } from "vitest";
import { toFriendlyError } from "../error-text";

describe("toFriendlyError", () => {
  it("每种 ProviderErrorKind 都有映射（新增 kind 必须补文案）", () => {
    for (const kind of ["auth", "rate-limit", "server", "bad-request", "network", "aborted"] as const) {
      const friendly = toFriendlyError({ kind, message: "raw" });
      expect(friendly.headline.length).toBeGreaterThan(0);
      expect(friendly.actionLabel.length).toBeGreaterThan(0);
    }
  });

  it("auth 指向设置，可重试类指向重试", () => {
    expect(toFriendlyError({ kind: "auth", message: "" }).action).toBe("settings");
    expect(toFriendlyError({ kind: "network", message: "" }).action).toBe("retry");
    expect(toFriendlyError({ kind: "rate-limit", message: "" }).action).toBe("retry");
    expect(toFriendlyError({ kind: "server", message: "" }).action).toBe("retry");
    expect(toFriendlyError({ kind: "bad-request", message: "" }).action).toBe("settings");
  });

  it("aborted 是中性提示不是报错", () => {
    const friendly = toFriendlyError({ kind: "aborted", message: "" });
    expect(friendly.action).toBe("dismiss");
  });

  it("未知 kind 兜底为网络话术（不抛错）", () => {
    const friendly = toFriendlyError({ kind: "unknown" as never, message: "" });
    expect(friendly.headline).toContain("网络");
  });

  it("文案不含内部枚举词（附录 B：说人话）", () => {
    for (const kind of ["auth", "rate-limit", "server", "bad-request", "network", "aborted"] as const) {
      const friendly = toFriendlyError({ kind, message: "" });
      for (const banned of ["bad-request", "rate-limit", "provider", "429", "401", "5xx", "tool_call"]) {
        expect(friendly.headline).not.toContain(banned);
      }
    }
  });
});
