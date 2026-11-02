/**
 * validateSchema 单测 —— 规格来源：docs/learning/01-agent-loop.md §4.2。
 * 错误文案面向模型（会作为工具错误回传），断言覆盖每个 type 分支与嵌套路径。
 */
import { describe, expect, it } from "vitest";
import { validateSchema } from "../validate-schema";
import type { JsonSchemaObject } from "@/agent/providers/types";

const todoSchema: JsonSchemaObject = {
  type: "object",
  properties: {
    title: { type: "string", description: "标题" },
    state: { type: "string", enum: ["happy", "sad"] },
    top_k: { type: "number" },
    include_done: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["title"],
};

describe("validateSchema", () => {
  it("合法参数通过（返回 null）", () => {
    expect(
      validateSchema(todoSchema, { title: "开周会", state: "happy", top_k: 5, include_done: false, tags: ["a"] }),
    ).toBeNull();
  });

  it("缺少必填字段 → 错误信息含字段名", () => {
    const err = validateSchema(todoSchema, {});
    expect(err).toContain("title");
  });

  it("string 类型错误与 enum 约束", () => {
    expect(validateSchema(todoSchema, { title: 123 })).toContain("title");
    const err = validateSchema(todoSchema, { title: "x", state: "angry" });
    expect(err).toContain("happy/sad");
  });

  it("number 必须有限数值", () => {
    expect(validateSchema(todoSchema, { title: "x", top_k: 5 })).toBeNull();
    expect(validateSchema(todoSchema, { title: "x", top_k: "5" })).toContain("top_k");
    expect(validateSchema(todoSchema, { title: "x", top_k: Number.NaN })).toContain("top_k");
  });

  it("boolean 严格类型", () => {
    expect(validateSchema(todoSchema, { title: "x", include_done: "yes" })).toContain("include_done");
  });

  it("array + items 嵌套错误带下标路径", () => {
    const err = validateSchema(todoSchema, { title: "x", tags: ["ok", 42] });
    expect(err).toContain("[1]");
  });

  it("非对象输入", () => {
    expect(validateSchema(todoSchema, null)).toContain("应为 object");
    expect(validateSchema(todoSchema, [])).toContain("应为 object");
  });

  it("未知 schema 类型放行（交由工具内部兜底）", () => {
    expect(validateSchema({ type: "object" } as JsonSchemaObject, { anything: 1 })).toBeNull();
  });
});
