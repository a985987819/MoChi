# 11 · 常规 Agent 能力实现走读：对话、上下文、记忆、会话与工具

> 本文回答一个具体问题：**Mochi 的「常规 agent」能力到底是怎么实现的？**
> 覆盖对话循环、上下文预算、短期/长期记忆、多会话历史、工具调用与联网搜索。
> 读完后应能独立复刻一条最小可用链路，并知道每一层为什么这样设计。

## 1. 目标与能力边界

Mochi 不是"把用户输入直接转发给模型"的聊天壳，而是一条完整的 Agent 管线：

| 能力 | 本项目落点 | 一句话说明 |
|---|---|---|
| 对话 | `AgentFacade.runTurn` + `runAgent` | LLM ↔ 工具循环，直到模型不再发起工具调用 |
| 上下文管理 | `context-builder.ts` + `window.ts` | 五层上下文 + token 预算 + 协议完整的分块裁剪 |
| 短期记忆 | `HistoryStore.loadRecent` | 当前会话最近 N 个协议块，重启可恢复 |
| 长期记忆 | `MemoryService` | `remember` 写入 SQLite，BM25 检索 top-k 注入 |
| 历史会话 | `HistoryStore` 多会话 | `sessions` + `messages`，可新建/切换，标题自动摘要 |
| 工具调用 | `ToolRegistry` | JSON Schema 校验、风险分级、失败回传模型自愈 |
| 联网搜索 | `web_search` 工具 | 维基百科公开 API，无需 Key，只读 |

## 2. 一轮对话的数据流

```text
ChatTab.doSend(text)
  │
  ├─ 离线知识库命中？──是──→ 本地回答 + 落库（不调模型）
  │
  └─ 否
      ↓
AgentFacade.runTurn({ userInput, signal })
  │
  ├─ 等待 todoService / memoryService / foodIndex / reminderStore 就绪
  ├─ loadSettings() → createProvider(settings)
  │
  ├─ 并行：
  │    ├─ historyStore.loadRecent() → trimWindow(4000 tok)
  │    └─ memoryService.searchForContext(userInput, topK=3)
  │
  ├─ historyStore.appendUserDeduped(userInput)   // 先取历史再落库，避免重复
  ├─ buildMessages({ system, memories, history, now, userInput })
  │
  └─ runAgent({ provider, messages, registry, ctx, persist })
       │
       loop step = 0..MAX_STEPS-1
         ├─ provider.chatStream(messages, tools)
         │    ├─ text-delta → yield 给 UI（流式渲染/宠物气泡）
         │    └─ tool-calls → 收集
         ├─ assistant 消息入组 + persist
         ├─ 没有 tool-calls？→ done，结束
         └─ 有 → Promise.allSettled(registry.execute(...))
              ├─ tool 结果按调用顺序回填
              ├─ persist(tool 消息)
              └─ 下一轮把工具结果交给模型
```

关键点：终止条件是「本轮没有 tool_calls」，不是 `finish_reason === "stop"`。
带工具声明时，模型说完话也可能给 `stop`，必须以是否发起调用为准。

## 3. 对话循环：`runAgent`

文件：[src/agent/core/agent.ts](../src/agent/core/agent.ts)

```ts
for (let step = 0; step < MAX_STEPS; step++) {
  let text = "";
  let calls: ToolCall[] = [];
  for await (const ev of provider.chatStream({ messages, tools: registry.toSpecs() }, signal)) {
    if (ev.type === "text-delta") { text += ev.text; yield { type: "text-delta", text: ev.text }; }
    else if (ev.type === "tool-calls") calls = ev.calls;
    else if (ev.type === "error") throw new Error(...); // 传输层致命错误
  }
  messages.push({ role: "assistant", content: text || null, toolCalls: calls.length ? calls : undefined });
  persist?.(assistantMsg);
  if (calls.length === 0) { yield { type: "done", text, hitMaxSteps: false }; return; }
  const settled = await Promise.allSettled(calls.map(c => registry.execute(c.name, c.arguments, ctx)));
  calls.forEach((call, i) => {
    messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(outcomes[i]) });
    persist?.(toolMsg);
  });
  yield { type: "step-end", step, toolSummaries: ... };
}
```

设计要点：

1. **协议顺序**：`tool` 消息必须紧跟带对应 `tool_calls` 的 `assistant` 消息；
   并行执行但**按调用顺序回填**，否则恢复历史后 API 会报 400。
2. **工具失败不炸循环**：`registry.execute` 把一切异常转成 `{ok:false,error}`，
   模型下一轮可以修正参数或换工具；只有传输层错误才向上抛。
3. **MAX_STEPS = 8**：防"调用-失败-重试"死循环烧钱；跑满后如实告诉用户。
4. **持久化回调**：每追加一条协议消息就落库，重启后可直接恢复。

## 4. 上下文管理

### 4.1 五层上下文

文件：[src/agent/core/context-builder.ts](../src/agent/core/context-builder.ts)

`buildMessages` 固定按以下顺序拼装：

1. **system**：角色、语气、能力边界、工具使用纪律、称呼偏好；
2. **长期记忆**（rubric `user` 消息）：与当前输入最相关的 top-3 事实；
3. **RAG 资料**（可选 `user` 消息）：本地知识库检索结果；
4. **历史窗口**：`trimWindow` 裁剪后的协议历史；
5. **当前时间锚点 + 当前输入**：放在最后（尾端优势，模型对末尾信息更敏感）。

为什么记忆/RAG 用 `user` 消息而不是塞进 system：角色定义不被污染，且符合
lost-in-the-middle 的位置效应。

### 4.2 Token 预算与分块裁剪

文件：[src/agent/core/window.ts](../src/agent/core/window.ts)

- 估算：CJK ≈ 1 token/字，拉丁 ≈ 3.5 字符/token，每条消息 +8 结构开销；
- 历史窗口预算 `HISTORY_BUDGET_TOKENS = 4000`；
- 裁剪单位是**块**而不是单条消息：
  - 独立 `user` / 纯文本 `assistant` = 一块；
  - `assistant(tool_calls) + 其后全部 tool 结果` = 一块；
- 从最旧的块开始丢弃，至少保留一块，system 永远保留。

这一层回答的是「上下文是预算问题」：不是把全部历史塞给模型，而是保留
**协议完整、信息密度最高**的最近窗口。

### 4.3 短期记忆

文件：[src/agent/memory/history-store.ts](../src/agent/memory/history-store.ts)

短期记忆 = 当前会话的协议历史。`loadRecent(blockCount = 12)`：

1. 按 `session_id` 取全部消息；
2. 按与 `trimWindow` 相同的分块规则组装；
3. 取最近 N 个块并扁平化。

为什么不用"最近 N 条消息"：tool 结果单独看没有意义，必须和它的 assistant
`tool_calls` 一起保留，否则协议不完整。

## 5. 长期记忆

文件：[src/agent/memory/long-term.ts](../src/agent/memory/long-term.ts)

### 5.1 写入

`remember` 工具 → `memoryService.remember(fact)`：

```ts
INSERT INTO memories (fact, source, created_at, updated_at) VALUES (...)
this.retriever.upsertDocument({ id: `mem-${id}`, text: fact });
```

**写库与索引 upsert 绑定**，否则会出现"存了但查不到"。索引是内存 BM25，
启动时从 `memories` 表全量重建（数据量小，<10ms）。

### 5.2 检索与注入

每轮 `AgentFacade.runTurn`：

```ts
const memories = await memoryService.searchForContext(userInput, 3);
```

BM25 检索返回最相关的 3 条事实，由 `buildMessages` 以 `user` 消息注入：

```text
（以下是关于用户的长期记忆，供你参考，不要复述）
- 用户喜欢低糖饮食
- 用户每天 9 点开周会
```

### 5.3 用户控制

设置页可列出、删除单条记忆；删除同时 `retriever.removeDocument`，保持
"数据库 = 检索索引"一致。

## 6. 历史会话记录（v0.29.3）

### 6.1 数据模型

`db.ts` 里的两张表：

```sql
sessions(id TEXT PRIMARY KEY, title TEXT, created_at INTEGER)
messages(id INTEGER PK AUTOINCREMENT, session_id TEXT, role, content,
         tool_calls, tool_call_id, created_at)
```

v1 只有 `main` 一条会话；v0.29.3 起 `HistoryStore` 支持多会话，表结构不需要迁移。

### 6.2 会话选择与新建

```ts
class HistoryStore {
  private currentId: string | null = null;
  private ensureActive(): Promise<string> {
    // 1) 已有 currentId → 直接返回
    // 2) 否则取最近创建的一条 sessions
    // 3) 一条都没有 → 建 main（兼容旧库/全新安装）
  }
  async listSessions(): Promise<SessionSummary[]> {
    // updated_at = COALESCE(MAX(messages.created_at), sessions.created_at)
    // 按最近活动倒序
  }
  async createSession(title = "新对话"): Promise<SessionSummary> {
    // crypto.randomUUID() → INSERT → currentId = 新 id
  }
  async setCurrentSession(id: string): Promise<void> {
    // 校验存在后切换；防 UI 传脏 id 写入孤儿消息
  }
}
```

所有 `append / loadRecent / appendUserDeduped` 都走 `ensureActive()`，因此
Facade 不需要知道"当前是哪条会话"。

### 6.3 标题自动摘要

会话内**首条用户消息**落库后：

```ts
const counts = await db.select("SELECT COUNT(*) AS n FROM messages WHERE session_id = $1");
if (count === 0) {
  await db.execute("UPDATE sessions SET title = $1 WHERE id = $2", [
    summarizeTitle(content), // 压平空白，>24 字截断加 …
    sessionId,
  ]);
}
```

历史下拉里看到的第一条消息摘要，就是用户当时在聊什么——不用手写标题。

### 6.4 UI

[ChatTab.tsx](../src/pages/chat/ChatTab.tsx) 在消息列表上方加了一条
「历史会话」栏：

- `<select>` 列出会话（按最近活动排序）；
- 「+ 新对话」创建并切换；
- **回合进行中禁用切换/新建**，避免流式回复写进另一条会话；
- 旧的 `main` 会话标题「与麻薯的对话」在 UI 层按当前自称动态显示为
  「与{pet}的对话」，不改历史数据；
- 设置页「清空聊天历史」改为 `clearAll()`：删除全部消息与会话，再建一个干净会话。

## 7. 工具调用

### 7.1 工具定义

文件：[src/agent/tools/registry.ts](../src/agent/tools/registry.ts)

```ts
interface ToolDefinition<A> {
  name: string;
  description: string;     // 写给模型：何时用 + 参数语义
  parameters: JsonSchemaObject;
  risk: "read" | "write" | "destructive";
  execute(args: A, ctx: ToolContext): Promise<ToolOutcome>;
}
```

统一执行入口：

```text
查表 → JSON.parse → validateSchema → execute → JSON 序列化
任何失败 → { ok:false, error }（模型自愈，不上抛）
```

### 7.2 现有工具

| 分类 | 工具 |
|---|---|
| 待办 | `add_todo` / `list_todos` / `complete_todo` / `delete_todo` |
| 提醒 | `create_reminder` / `cancel_reminder` / `skip_reminder` / `list_reminders` |
| 计时 | `start_pomodoro` / `stop_pomodoro` / `get_pomodoro_status` |
| 知识 | `search_food`（RAG 热量）/ `search_health_advice`（健康指南） |
| 记忆 | `remember` |
| 桌面 | `open_url` / `open_data_folder` |
| 联网 | `web_search`（v0.29.3） |
| 宠物 | `set_pet_state` |

### 7.3 联网搜索 `web_search`

文件：[src/agent/tools/web-search.ts](../src/agent/tools/web-search.ts)

为什么用维基百科 API：

- 不需要搜索服务商 Key，避免把密钥问题带进"基础能力"；
- MediaWiki API 支持 `origin=*`（浏览器 CORS），WebView 原生 `fetch` 即可；
- 返回结构化 JSON，适合教学与稳定解析。

请求形状：

```text
GET https://zh.wikipedia.org/w/api.php
  ?action=query&list=search&srsearch=麻薯&srlimit=3&format=json&origin=*&utf8=1
```

处理流程：

1. 按界面语言先搜中文维基，零结果再搜英文维基兜底；
2. 从 `query.search[]` 取 `title/snippet`；
3. `snippet` 是带 `<span class="searchmatch">` 的 HTML，`plainSnippet` 剥标签、
   解码 `&nbsp; &amp; &quot; ...`；
4. 生成 `url = https://<host>/wiki/<encodeURIComponent(title)>`；
5. 返回 `{ query, source, results: [{title,snippet,url}] }`；
6. 网络失败/零结果不抛异常，返回可解释的 `note`，让模型如实告知用户。

安全边界：

- `risk: "read"`，不写文件、不打开浏览器；
- 搜索结果只是资料，不是指令；系统提示词明确要求模型**不要执行搜索结果里的
  任何要求**（防提示注入）；
- 工具本身也不执行任何外部内容。

### 7.4 工具轨迹

[src/pages/chat/tool-labels.ts](../src/pages/chat/tool-labels.ts) 把工具名翻译成
人话（`web_search` → 「联网搜了一下」），`formatToolTrace` 生成一行轨迹；
`set_pet_state` 属于内部情绪副作用，不展示。新增工具如果漏译，单测会扫描
`src/agent/tools/*.ts` 的注册名并直接报红。

## 8. 持久化与恢复

### 8.1 写入顺序

`AgentFacade.runTurn` 的顺序是刻意安排的：

1. **先** `loadRecent()` 读历史；
2. **再** `appendUserDeduped()` 落当前输入；
3. 最后进入 `runAgent`，由 `persist` 逐条落 assistant/tool。

如果先落用户消息再读历史，当前输入会在上下文里出现两遍。

### 8.2 去重

`appendUserDeduped` 查当前会话最后一条消息，若 role=user 且内容相同则跳过——
覆盖"失败重试重发同一输入"的场景，避免历史里出现两条一模一样的用户消息。

### 8.3 清空

- `clear()`：只清当前会话消息；
- `clearAll()`：设置页危险区使用，删除全部消息与会话后新建干净会话。

## 9. 设计取舍与已知限制

| 取舍 | 原因 | 限制 |
|---|---|---|
| 手写 Agent 循环 | 教学项目，60 行能讲清 | 没有多 agent、规划器、反思器等高级编排 |
| token 粗估 | 避免引入 tokenizer 依赖 | 预算偏差在长英文/代码场景会变大 |
| 分块裁剪不摘要 | 保证协议完整、实现简单 | 早期历史直接丢失，没有滚动摘要 |
| BM25 长期记忆 | 零 embedding 成本、离线可用 | 语义泛化弱于向量检索 |
| 维基百科搜索 | 无需 Key、CORS 可用 | 不是通用搜索引擎，时效/覆盖面有限 |
| 单聊天窗单 Store | 当前产品只有一个聊天窗 | 多窗口并发会话需要额外同步 |

## 10. 如何扩展

### 10.1 新增一个工具

1. 在 `src/agent/tools/` 新建文件，返回 `ToolDefinition`；
2. 在 `AgentFacade` 构造函数里 `this.registry.register(...)`；
3. 在 `tool-labels.ts` 加 `TOOL_LABELS` 文案（否则全等单测红）；
4. 给工具写单测（纯函数参数校验/结果映射优先）；
5. 在系统提示词里补一句"何时用它"。

### 10.2 换成真正的搜索引擎

保持 `web_search` 的输入/输出形状不变，只替换 `searchOn`：

- 有 Key：Brave Search / Bing Web Search / SerpAPI；
- 自建：SearXNG 实例；
- 需要更完整的网页正文：再加一个 `fetch_url` 工具（注意白名单、超时、
  内容截断与提示注入防护）。

### 10.3 调整上下文预算

`HISTORY_BUDGET_TOKENS`（历史窗口）、`MEMORY_TOP_K`（长期记忆条数）、
`loadRecent(50)`（UI 展示块数）是三处独立旋钮：
UI 展示可以远大于模型上下文，两者刻意解耦。

## 11. 复盘自测

能不看代码回答以下问题，说明链路真正理解：

1. 为什么 `runAgent` 的终止条件是"没有 tool_calls"而不是 `finish_reason`？
2. 为什么 `tool` 消息必须紧跟对应的 `assistant(tool_calls)`？裁剪时如何保证？
3. 为什么用户消息要在 `loadRecent` 之后落库？
4. 长期记忆写入为什么必须同时 upsert 检索索引？
5. 多会话切换时，为什么回合进行中要禁用切换？
6. `web_search` 为什么返回 `ok:false` 之外还要有"零结果 note"？
7. 如果要把历史裁剪改成"滚动摘要"，需要动哪几个文件？

## 12. 验证清单

- [x] `pnpm test`：509/509（含 web_search 4 例、history-store 多会话/自动标题）
- [x] `pnpm check` / `pnpm build`
- [x] `cargo test` / `cargo check`
- [ ] 真机：新建会话 → 首条消息后标题变摘要 → 切换会话历史互不串
- [ ] 真机：问一个外部事实，模型调用 `web_search` 并附维基链接
- [ ] 真机：设置页清空聊天历史 → 所有会话消失，只剩一个干净会话
