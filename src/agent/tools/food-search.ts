/**
 * search_food 工具 —— agentic RAG 的模型侧入口。
 * 规格：docs/learning/05-rag-bm25.md §5.5。
 *
 * description 三件事：适用场景（品牌范围）、**反幻觉合同**（数值只能来自返回条目）、
 * 未命中行为（如实说没查到 + 可给近似品注明）。工具输出剥掉 aliases（对模型无增益，
 * 省上下文——learning/03 工具结果瘦身原则）。
 */

import type { ToolDefinition } from "./registry";

export function foodSearchTool(): ToolDefinition<{ query: string; top_k?: number }> {
  return {
    name: "search_food",
    description:
      "查询食物热量与营养：常见快餐品牌（麦当劳/肯德基/汉堡王/必胜客/塔斯汀）菜单，" +
      "以及常见中餐家常菜/主食/水果/饮品（米饭、馒头、番茄炒蛋、苹果、牛奶、奶茶等）。" +
      "用户问到任何食物热量/营养时调用。" +
      "**回答营养数值时只能引用返回条目中的数据，逐条注明品名与份量；" +
      "返回为空或没有匹配项时，如实说没查到，可以提及返回结果中的近似品并注明'近似'，严禁编造数值。**" +
      "如需给出每日占比参考，以每日 2000 kcal 为基准。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "菜名或描述，可含品牌与口语（如：M记 麦辣鸡腿堡）" },
        top_k: { type: "number", description: "返回条数，默认 5" },
      },
      required: ["query"],
    },
    risk: "read",
    async execute(args, ctx) {
      const hits = ctx.services.food.search(args.query, args.top_k ?? 5);
      return {
        ok: true as const,
        data: {
          count: hits.length,
          results: hits.map(h => ({
            id: h.item.id,
            brand: h.item.brand,
            name: h.item.name,
            serving: h.item.serving,
            kcal: h.item.kcal,
            protein: h.item.protein,
            fat: h.item.fat,
            carbs: h.item.carbs,
            score: h.score,
          })),
        },
      };
    },
  };
}
