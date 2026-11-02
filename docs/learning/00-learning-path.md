# 00 · 学习路径总览 —— 用 Mochi 理解 Agent 开发

> 读者假设：你是前端工程师，熟练 TypeScript，没用过 Python 的 AI 技术栈。
> 这套文档是**规范先行**：每个版本写代码之前，先读对应文档；文档里的参考实现就是代码要遵守的规格。

## 1. 这套文档怎么用

1. **写前读**：进入某个版本前，读对应文档到能通过「复盘自测」；
2. **文档即规格**：文档中的接口定义、数据结构、行为约定，代码实现必须与之一致；不一致时以文档为准（或同步修订两者）；
3. **复盘自测是门槛**：合上文档能默写核心伪代码/协议，才算掌握，才开下一版；
4. **TS 优先**：所有参考实现都是 TypeScript；Rust 只出现在 Tauri 系统能力层（已有 06 文档覆盖）。

## 2. Agent 知识地图（概念 → 文档 → 版本）

| # | 概念 | 文档 | 落地版本 |
|---|---|---|---|
| 1 | Tauri 多窗口 / IPC / 权限模型 | [06-tauri-for-frontend](06-tauri-for-frontend.md) | v0.1.0 ✅ |
| 2 | LLM API 传输层：OpenAI 兼容协议、SSE 流式、多提供商抽象 | [02-provider-abstraction](02-provider-abstraction.md) | v0.3.0 |
| 3 | Agent 内核：工具调用循环、工具注册、错误自愈 | [01-agent-loop](01-agent-loop.md) | v0.4.0 |
| 4 | 上下文工程：系统提示、消息窗口、输出约定 | [03-context-engineering](03-context-engineering.md) | v0.4.0 |
| 5 | 记忆系统：会话持久化、滑动窗口、长期事实 | [04-memory](04-memory.md) | v0.5.0 |
| 6 | RAG：BM25 检索、中文分词、带引用回答 | [05-rag-bm25](05-rag-bm25.md) | v0.6.0 |
| 7 | **Agent 与桌面应用的边界**：意图/执行/存储三层归属、双入口模式、工具风险分级 | [07-agent-vs-app-boundary](07-agent-vs-app-boundary.md) | 全部（架构裁决） |
| 8 | 宠物状态机、在场检测（idle）、计时服务与自然语言提醒 | [08-timers-reminders-presence](08-timers-reminders-presence.md) | v0.2.0 / v0.7.0 |

**建议阅读顺序**：02（传输层）→ 01（编排层）→ 03（上下文）→ 04（记忆）→ 05（检索）；07 是横切裁决文档，新功能/新工具设计前必查；08 是 v0.7.0 的实现规范。
01 和 02 互为依赖：02 定义 `LLMProvider` 与消息类型，01 消费它们。

## 3. Mochi 的 Agent 架构总图

```
┌── UI 层（React）─────────────────────────────────────────┐
│  ChatApp        TodoTab       PomodoroTab     SettingsTab  │
│     │              │               │               │      │
│     ▼              ▼               ▼               ▼      │
│  ┌────────────── AgentFacade（唯一入口，事件驱动）──────┐ │
│  │  runAgent() 流式事件 → UI 渲染 / 宠物状态联动          │ │
│  └───────┬───────────────┬───────────────┬─────────────┘ │
└──────────┼───────────────┼───────────────┼───────────────┘
           ▼               ▼               ▼
┌── Agent 内核（纯 TS，不依赖 React）──────────────────────┐
│  core/agent.ts        —— Agent 循环（01）                │
│  core/context-builder —— 上下文组装（03）                │
│  providers/           —— LLM 传输（02）                  │
│  tools/registry.ts    —— 工具注册与执行（01）             │
│  memory/              —— 记忆分层（04）                  │
│  rag/                 —— BM25 检索（05）                 │
└──────┬────────────────────┬──────────────────────────────┘
       ▼                    ▼
┌── 服务层 ──────────┐  ┌── 持久层 ─────────────────┐
│ TimerService       │  │ SQLite (tauri-plugin-sql) │
│ PetStateManager    │  │  messages / todos /       │
│ Store（设置/Key）  │  │  memories                 │
└────────────────────┘  └───────────────────────────┘
```

**分层纪律**：Agent 内核不知道 React 的存在（纯函数 + 异步迭代器）；UI 只消费 `AgentEvent` 流。这是"内核可测试、UI 可替换"的关键。

## 4. 前端工程师前置知识自检

开始 02 之前，确认以下每项你都能"顺手写出"（都是 Web 标准，不需要新依赖）：

| 能力 | 最低标准 | 用在哪里 |
|---|---|---|
| `fetch` + `ReadableStream` | 能用 `res.body.getReader()` 读二进制流并 decode | SSE 解析（02） |
| 异步迭代器 | 能写 `async function*` 与 `for await...of` | 流式事件消费（02/01） |
| `AbortController` | 能贯穿传 signal 并在中断时清理资源 | 停止生成（02/01） |
| JSON Schema | 知道 type/properties/required/enum/items | 工具参数协议（01） |
| 判别联合 | `type` 字段收窄的 `union` 类型组织 | 事件与消息类型（全篇） |
| SQL 基础 | CREATE TABLE / SELECT / 参数绑定 | 记忆与历史（04） |

缺哪项补哪项即可，不用系统重学。

## 5. 术语表（按出场顺序）

| 术语 | 一句话定义 |
|---|---|
| LLM | 大语言模型。本质：`f(messages, options) → message` 的无状态函数 |
| Token | 模型的最小文本单位（约 0.7 个汉字或 0.25 个英文单词）；计费与上下文长度都以它计 |
| Context Window | 模型单次能"看到"的 token 上限（DeepSeek chat 64K，见官方文档） |
| System Prompt | `role:"system"` 的消息，定义角色与规则，权重最高 |
| Completion | 模型的一次生成回复 |
| Function Calling / Tool Use | 模型按你声明的 JSON Schema 输出"调用某工具"的结构化请求 |
| finish_reason | 本次生成的结束原因：`stop`（说完）/ `tool_calls`（要调工具）/ `length`（被截断） |
| SSE | Server-Sent Events，`text/event-stream` 的行式流协议，OpenAI 兼容 API 的流式载体 |
| Agent | LLM + 工具 + 循环 + 状态：模型决定下一步，代码执行并把结果喂回去，直到任务完成 |
| ReAct | 经典 Agent 模式：Reason（想）→ Act（调工具）→ Observe（看结果）循环 |
| Tool Registry | 工具的注册表：名称、描述、参数 Schema、执行器 |
| 幻觉 | 模型一本正经地编造事实；RAG 与工具是对抗它的主要手段 |
| RAG | 检索增强生成：先从外部知识里检索相关内容，再拼进上下文让模型基于它回答 |
| Embedding | 把文本映射为向量的模型，用于语义相似度检索 |
| BM25 | 基于词频的稀疏检索算法（TF-IDF 的改进），无需模型、纯算法 |
| Memory | Agent 的记忆：会话历史（情景）与用户事实（长期语义记忆） |
| Context Engineering | 上下文工程：决定每一轮"往窗口里放什么"的系统方法 |

## 6. 版本推进节奏（每版你新学到什么）

- **v0.3.0**：读懂一张 LLM API 的响应流；亲手实现 SSE 解析；理解"所有主流大模型 API 都在说 OpenAI 方言"
- **v0.4.0**：理解 Agent 不是prompt 玄学，而是一个 50 行的循环；工具协议的全部字段；让模型自我纠错
- **v0.5.0**：上下文是稀缺资源，预算与裁剪是工程问题；记忆分层的落地
- **v0.6.0**：RAG 不是"接个向量库"，检索质量来自分词/算法/评测；BM25 公式亲手实现

每版的「自测清单」见 `docs/roadmap.md`；每版的实施细节记录在 `docs/versions/`。
