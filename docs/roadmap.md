# Mochi 版本路线图（步骤规范）

> 本文件是**进度唯一事实源**。每版含：目标 / 前置 / 细化步骤 / 验收标准。
> 完成一个版本的全部验收标准后才开启下一版。版本实施细节记录在 `docs/versions/`。
>
> **文档先行**：v0.1.1 已一次性交付全部学习文档（00–05，见 `docs/learning/`）。
> v0.3.0–v0.6.0 的参考实现规格以对应文档为准——文档与代码不一致视为 bug。开工门槛：通过该文档的「复盘自测」。

---

## v0.1.0 — 环境与脚手架：三窗口 + 托盘骨架

**目标**：可运行的 Tauri 2 应用，宠物窗/聊天窗/提醒弹窗三窗口体系跑通，托盘常驻，透明置顶拖动生效。

**前置**：无（含环境安装）

**步骤**：
1. 环境安装：corepack 启用 pnpm → rustup + stable-msvc → VS Build Tools（C++ 工作负载）→ 记录到版本文档
2. `pnpm create tauri-app`（react-ts 模板）→ 清理模板 demo 代码
3. `tauri.conf.json`：三窗口声明（pet 主窗口：透明/无边框/置顶/固定尺寸/跳过任务栏；chat：480×620；alert：280×180 默认隐藏）；`macOSPrivateApi`
4. Rust 侧：tray-icon（菜单：显示/隐藏宠物、打开聊天、退出）、单实例插件、关闭窗口→隐藏而非退出（pet/chat）
5. React 侧：多入口（pet / chat / alert 三个 HTML 页面共享 React 代码）、pet 窗口拖动区域、占位宠物形象显示
6. 验证 & 文档：`pnpm tauri dev` 三窗口行为正确；学习文档 `06-tauri-for-frontend.md`

**验收标准**：
- [ ] `pnpm tauri dev` 启动后：透明宠物窗置顶显示、可拖动、任务栏无图标
- [ ] 双击宠物打开聊天窗；关闭聊天窗=隐藏，宠物窗仍驻留
- [ ] 托盘图标存在，菜单项可用；退出菜单真正退出进程
- [ ] 重复启动应用被单实例拦截
- [x] `cargo check` 通过，无编译警告新增（2026-11-03；GUI 项待用户 `scripts\vsenv.cmd pnpm tauri dev` 人工验证）

---

## v0.2.0 — 宠物状态系统：命名约定 + PetStateManager

**目标**：实现「图片文件名 = 宠物状态」的核心约定：扫描目录建索引、回退链、多变体轮换、事件驱动切换。

**步骤**：
1. `docs/pet-assets.md` 定义：状态集（idle/happy/sad/thinking/talking/alert/stretch/focus/break/sleep）、命名规则 `{state}.{ext}` 与变体 `{state}_N.{ext}`、支持格式
2. `PetStateManager`：启动扫描 `{appData}/pet-assets/` 与内置 `src/assets/pet/` 合并索引 → `setState(state, {duration})` → 状态优先级（系统事件 > 情绪 > idle）→ 超时回落 → 事件总线
3. 回退链：用户目录 → 内置素材 → 内置 SVG 占位（标注状态名，永不白屏）
4. 内置占位素材：脚本生成一套简单 PNG + 各状态 SVG 兜底
5. 右键菜单（宠物窗内自绘）：打开聊天 / 番茄钟 / 待办 / 设置 / 退出；单击宠物 = 重置站立计时（先接事件，v0.7 接计时器）
6. 学习文档：`pet-assets.md` 完善 + 版本文档

**验收标准**：
- [ ] 向 `{appData}/pet-assets/` 放入 `happy.gif`，宠物在触发 happy 状态时播放它，无需重启（待人工，指引 docs/pet-assets.md §5）
- [ ] 删除某状态素材后回落到占位 SVG，UI 不白屏不报错（待人工）
- [ ] `idle_2.png`、`idle_3.png` 存在时 idle 状态随机轮换（待人工）
- [ ] 系统事件状态（如 `focus`）期间 Agent 情绪状态不抢占；超时后自动回落 idle（待人工，表情演示可触发）
- [x] `pnpm check` / `vite build` / `cargo check` 通过（2026-11-03）

---

## v0.3.0 — Provider 抽象与流式对话

**目标**：`LLMProvider` 接口 + OpenAI 兼容实现（SSE 流式 + Function Calling 协议）+ DeepSeek 预设 + MockProvider + 设置 UI + 聊天窗流式渲染。

**步骤**：
1. `providers/types.ts`：`LLMProvider` 接口（`chatStream(messages, tools?, signal?)`，异步迭代器产出增量）
2. `openai-compatible.ts`：fetch + SSE 解析（增量 content / tool_call 拼接 / [DONE] / 错误分支 / AbortSignal）
3. `presets.ts`：DeepSeek / OpenAI / Kimi / 硅基流动 / Ollama 预设（baseURL + 默认模型 + key 获取链接）；`mock.ts`：可脚本化回复的测试提供商
4. 设置 Tab：提供商选择、Key 输入、模型选择、连通性测试按钮；`tauri-plugin-store` 持久化
5. 聊天 UI：消息流、markdown 渲染、流式光标、停止按钮、错误态（Key 无效/网络失败）
6. 学习文档：`02-provider-abstraction.md`（SSE 协议逐字节讲解）

**验收标准**：
- [ ] 配置 DeepSeek Key 后流式回复逐字渲染，中途可停止（待人工）
- [ ] 断网/错 Key 有明确错误提示，应用不崩溃（待人工）
- [ ] MockProvider 模式下无 Key 可走通全部 UI 流程（代码路径完整，交互待人工）
- [ ] Key 持久化在 store 中，重启后仍生效；日志与界面不泄露 Key 明文（待人工）
- [x] `pnpm check` / `vite build` / `cargo check` 通过（2026-11-03）

---

## v0.4.0 — Agent 循环与工具调用（待办功能上线）

**目标**：标准 Agent Loop：LLM ↔ 工具循环直至终答；ToolRegistry（JSON Schema 校验）；`set_pet_state` / `todo_*` 工具；对话驱动待办 + 宠物情绪联动。

**步骤**：
1. `tools/registry.ts`：工具定义（name/description/JSON Schema/执行器）、参数校验、错误回传 LLM 的规范格式
2. `core/agent.ts`：循环（≤N 轮防失控）、消息序列管理（assistant/tool 消息协议）、工具并发执行
3. `core/context-builder.ts`：系统提示词（角色/能力边界/工具使用指引/情绪状态约定）+ 消息窗口拼装
4. 工具实现：`set_pet_state`、`add_todo` / `list_todos` / `complete_todo` / `delete_todo`（先存内存/Store，v0.5 迁 SQLite）
5. 待办 Tab：列表、勾选完成、删除；宠物端情绪状态联动（对话中被夸→happy）
6. 学习文档：`01-agent-loop.md` + `03-context-engineering.md`

**验收标准**：
- [ ] "帮我加个待办：明天 9 点开周会" → 待办 Tab 出现该条目，回复自然语言确认（待人工）
- [ ] "我待办都有啥" / "把周会那条完成了" 正确调用工具（待人工）
- [ ] 一轮对话内连续多工具调用（如同时加两条待办）正常（待人工）
- [ ] 对话说"你好可爱"宠物变 `happy`，回复结束后若干秒回落（待人工）
- [ ] LLM 幻觉调用不存在的工具/参数不合法时，错误回传后 LLM 能自我纠正（待人工）
- [x] `pnpm check` / `vite build` / `cargo check` 通过（2026-11-03）

---

## v0.5.0 — 记忆系统：SQLite 历史 + 窗口 + 长期记忆

**目标**：三层记忆落地：SQLite 全量会话持久化、短期滑动窗口（token 预算）、长期事实记忆（remember 工具写入 + 每轮 BM25 检索注入）。

**步骤**：
1. `tauri-plugin-sql` 接入，建表：`sessions` / `messages` / `todos` / `memories`；待办从 Store 迁移 SQLite
2. `memory/history-store.ts`：消息读写、按会话组织、重启后历史恢复
3. `memory/window.ts`：滑动窗口（保留最近 N 条 + token 预算裁剪策略）
4. `memory/long-term.ts`：`remember(fact)` 工具；每轮 context-builder 用检索模块取 top-k 相关记忆注入
5. 设置/聊天 UI：清空历史按钮；记忆查看入口
6. 学习文档：`04-memory.md`（三层记忆模型与业界做法）

**验收标准**：
- [ ] 重启应用后聊天历史还在（含工具轨迹）（待人工）
- [ ] "记住我喜欢低糖饮食" → 写入 memories；新会话问"我饮食要注意什么"能回忆起（待人工）
- [ ] 长对话超出窗口后，早期上下文被裁剪但长期记忆仍注入（待人工，可临时调小预算验证）
- [ ] `memories` 表可查看、可删除单条（设置页已实现，交互待人工）
- [x] 待办从 Store 迁移 SQLite（旧数据自动迁移）+ 四表 DDL + `pnpm check`/`vite build`/`cargo check` 通过（2026-11-03）
- [x] 单测基建（vitest）+ 30/30 通过（tokenizer/bm25/trimWindow/validate-schema）；就绪竞态与落库顺序两个 bug 修复（完善批次，2026-11-03）

---

## v0.6.0 — RAG 热量查询

**目标**：BM25 检索管线（中文 bigram + 同义词表）+ 内置快餐数据集 + `search_food` 工具，实现带条目引用的热量问答。

**步骤**：
1. 数据集 `src/rag/data/food/*.json`：~130 条（麦当劳~50、肯德基~40、汉堡王/必胜客/塔斯汀~40），字段 id/brand/name/aliases/category/serving/kcal/protein/fat/carbs/note，标注"约值"
2. `rag/tokenizer.ts`：中文 bigram + 英文数字词元；`rag/bm25.ts`：自写 BM25（k1/b 参数、IDF/TF 打分，分步注释）
3. `rag/indexer.ts` + `rag/retriever.ts`：文档化（品名+别名+品牌拼接）、倒排索引、`Retriever` 接口（BM25 实现 + VectorRetriever 占位）
4. `synonyms.ts`：同义词/别名映射（巨无霸=BigMac 等）
5. `food-search` 工具接入 Agent；回答规范：引用条目（品名/份量/kcal），给出每日占比参考
6. 学习文档：`05-rag-bm25.md`

**验收标准**：
- [ ] "巨无霸多少热量" → 返回准确条目 + 引用；"M 记的麦辣鸡腿堡呢"（别名/口语）也能命中（待人工）
- [ ] "帮我配一顿 800 千卡以内的麦当劳" → 组合多条目给出方案（待人工）
- [ ] 查无此品时 LLM 明确说没有并给近似项，不编造数值（待人工）
- [x] 精度评测：10 个典型 query Hit@3 = 10/10（门槛 ≥9），46/46 测试全绿；`pnpm check`/`vite build`/`cargo check` 通过（2026-11-03）

---

## v0.7.0 — 计时服务：站立提醒 + 番茄钟 + 自然语言提醒（实现规范：learning/08）

**目标**：TimerService（驻留 pet 窗口，时间戳基准）：站立提醒闭环、番茄钟状态机、**在场检测（Rust idle 查询）**、**自然语言一次性提醒（reminders 表持久化 + create/cancel/list 工具 + 上下文注入当前时间）**。

**步骤**：
1. `services/timers.ts`：StandupService（间隔可配置、单击宠物重置、到点弹窗+`alert`+通知、用户离开时推迟弹窗）+ PomodoroService（idle→focus→break、休息结束不自动续轮）
2. Rust `get_idle_seconds` 命令（user-idle crate 或平台手写）+ `services/presence.ts`（active/away，迟滞 5min，驱动 `sleep` 状态与提醒推迟）
3. Alert 弹窗页：宠物 `alert` 形象 + 文案，点击 → `stretch` → 重置；10 分钟未点自动收尾重置
4. 通知：tauri-plugin-notification（番茄钟结束/站立提醒/自定义提醒，可开关）
5. reminders 表 + `services/reminders.ts`（落库即排程、重启恢复、触发补发一次）+ 上下文注入当前时间
6. Agent 工具：`start_pomodoro` / `stop_pomodoro` / `get_pomodoro_status` / `create_reminder` / `cancel_reminder` / `list_reminders`（含时间硬校验与歧义澄清回环）
7. 番茄钟 Tab + 提醒列表 UI；联调全部状态联动

**验收标准**：
- [ ] 间隔临时调 1 分钟：到点弹窗出现且宠物 `alert`；点击弹窗重置并播放 `stretch`（待人工）
- [ ] 模拟无输入 5 分钟（临时调阈值）宠物进 `sleep`；恢复输入立即退出；期间到点的站立提醒在恢复活动后补弹（待人工）
- [ ] 番茄钟 focus 中宠物锁定 `focus` 状态；到点通知；休息结束回到 idle 而非自动续轮（待人工）
- [ ] 对话"来个番茄钟"/"停下番茄钟"正确启停；"focus 中再启动"返回失败并自我纠正（待人工）
- [ ] 对话"半小时后提醒我喝水"→ reminders 表新增一条、到点通知+宠物提示；"明早九点提醒我交周报"时间解析正确（待人工）
- [ ] 对话"每周一提醒我…"被引导降级（说明暂不支持周期提醒）；提醒创建后重启应用仍触发（待人工）
- [x] 全部代码落地（两服务+presence+scheduler+6 工具+当前时间注入+设置热更新）；`pnpm test` 46/46 + `pnpm check`/`vite build`/`cargo check` 通过（2026-11-03）

---

## v0.8.0 — 打包分发 + CI + 文档收官

**目标**：Windows 本地安装包验证；GitHub Actions 双平台自动构建（tag 触发 Release）；文档收官。

**步骤**：
1. Windows 本地 `pnpm tauri build`：NSIS/MSI 安装包，安装实测（升级/卸载/数据保留）
2. 应用图标（icns/ico 生成）、安装包中文语言配置
3. `.github/workflows/release.yml`：matrix（windows/macos），tauri-action，tag `v*` 触发上传 Release（draft，人工确认发布）
4. README 快速开始与截图、roadmap 收尾勾选、全文档一致性检查
5. 显式声明的首次发布：push + tag（走部署纪律）

**验收标准**：
- [ ] Windows 安装包装得上、卸载干净、更新后 SQLite/Store 数据保留（待人工；NSIS 2.49MiB/MSI 3.45MiB 已产出）
- [ ] 推 tag 后 CI 产出 .msi/.exe 与 .dmg 并附到 GitHub Release（待人工；release.yml 就绪，Release 走 draft 由所有者确认，**push/tag 需显式声明**）
- [ ] 新机器按 README 从零到跑通无歧义（待人工）
- [x] 全部 learning 文档通过「复盘自测」结构完整性检查（9/9，2026-11-03）
- [x] 图标全套（gen-icon.mjs + tauri icon）+ NSIS 简体中文/per-user 配置 + 本地打包双产物验证（2026-11-03）

---

## 后续候选（Backlog，不在当前承诺内）

- `{state}_001.png` 帧序列动画支持；鼠标点击物理反馈；宠物拖拽惯性
- VectorRetriever 落地（本地 ONNX bge-small-zh），RAG 升级混合检索
- 更多提供商预设（GLM/通义）；本地 Ollama 一键检测
- 待办与系统日历联动；站立提醒统计报表
