/**
 * search_health_advice 工具 —— 健康域的 agentic RAG 模型侧入口（v0.9.0 健康扩展）。
 *
 * 与 search_food 同一合同结构：description 三件事（适用场景、反幻觉合同、未命中行为），
 * 输出剥掉 keywords（对模型无增益，省上下文——learning/03 工具结果瘦身原则）。
 * 健康域多一条**引用合同**：建议必须注明来源文件（source 字段逐字转述），
 * 以及**诊疗边界**：本工具返回的是公共指南科普，疾病诊疗一律建议就医。
 */

import type { ToolDefinition } from "./registry";

export function healthSearchTool(): ToolDefinition<{ query: string; top_k?: number }> {
  return {
    name: "search_health_advice",
    description:
      "检索国家发布的健康与运动建议（来源：《中国居民膳食指南（2022）》、《全民健身指南》、" +
      "《健康中国行动（2019—2030年）》、《中国成人身体活动指南》等），覆盖膳食搭配、" +
      "日常运动量、久坐办公族健康、健身动作要领与训练安排、体重管理。用户问吃什么健康、" +
      "怎么运动、久坐腰颈椎、某个健身动作怎么做、怎么减脂等话题时调用。" +
      "**回答时只能引用返回条目中的建议，并逐条注明来源文件；" +
      "返回为空或没有匹配项时，如实说没有对应建议条目，严禁编造指南条文或具体数字。**" +
      "涉及疾病诊断治疗、用药、急性疼痛的问题不要给建议，提醒用户咨询专业医生。" +
      "回答可以结合多条条目组织建议，但每条建议都要能对应到返回的来源。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "健康/运动话题，可口语化（如：久坐腰疼怎么办、深蹲膝盖内扣、每天吃多少盐）" },
        top_k: { type: "number", description: "返回条数，默认 4" },
      },
      required: ["query"],
    },
    risk: "read",
    async execute(args, ctx) {
      const hits = ctx.services.health.search(args.query, args.top_k ?? 4);
      return {
        ok: true as const,
        data: {
          count: hits.length,
          results: hits.map(h => ({
            id: h.item.id,
            category: h.item.category,
            title: h.item.title,
            source: h.item.source,
            text: h.item.text,
            score: h.score,
          })),
        },
      };
    },
  };
}
