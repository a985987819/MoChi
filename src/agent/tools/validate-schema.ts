/**
 * 迷你 JSON Schema 校验器 —— 规格：docs/learning/01-agent-loop.md §4.2。
 *
 * 只实现工具参数用得着的子集：type / properties / required / enum / items。
 * 设计立场（01 §2.2）：**参数校验在代码侧，不在模型侧**——模型的输出只是"建议"。
 * 生产项目可换 ajv；手写一遍才知道校验器在干嘛（这是它存在的教学理由）。
 */

import type { JsonSchemaObject } from "@/agent/providers/types";

/**
 * 校验 value 是否满足 schema。返回 null = 通过；返回字符串 = 失败原因（会作为
 * 工具错误回传给模型，让它自我纠正——所以文案要让模型看得懂）。
 */
export function validateSchema(schema: JsonSchemaObject, value: unknown): string | null {
  const err = (msg: string) => `${msg}（期望 ${JSON.stringify(schema)}，实际 ${JSON.stringify(value)}）`;

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return err("应为 object");
      for (const key of schema.required ?? []) {
        if (!(key in value)) return `缺少必填字段 ${key}`;
      }
      for (const [k, v] of Object.entries(value)) {
        const sub = schema.properties?.[k];
        if (sub) {
          const msg = validateSchema(sub, v);
          if (msg) return `${k}: ${msg}`;
        }
      }
      return null;
    }
    case "string": {
      if (typeof value !== "string") return err("应为 string");
      if (schema.enum && !schema.enum.includes(value)) return `取值必须是 ${schema.enum.join("/")}`;
      return null;
    }
    case "number": {
      return typeof value === "number" && Number.isFinite(value) ? null : err("应为 number");
    }
    case "boolean": {
      return typeof value === "boolean" ? null : err("应为 boolean");
    }
    case "array": {
      if (!Array.isArray(value)) return err("应为 array");
      if (schema.items) {
        for (const [i, v] of value.entries()) {
          const msg = validateSchema(schema.items as JsonSchemaObject, v);
          if (msg) return `[${i}]: ${msg}`;
        }
      }
      return null;
    }
    default:
      return null; // 未知类型放行，交由工具内部兜底
  }
}
