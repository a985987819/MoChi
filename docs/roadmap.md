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
- [x] 基础服务回归加固（随 v0.8.1，2026-11-04）：番茄钟权威回执/并发启停、站立提醒收尾、按服务仲裁状态、在场推迟、真实 SQLite CRUD/条件认领/取消；全量 88/88 + check/build 通过。原生 GUI 与真实模型联调仍未验收。

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
- [x] Windows 安装包装得上、卸载干净、数据保留（2026-11-03 静默安装自动化实测：装→跑→卸→重装全链路 ✓，mochi.db 保留）
- [x] push main + tag v0.8.0 到 github.com/a985987819/MoChi（2026-11-03，用户显式声明；CI 首跑结果见 GitHub Actions 页，Release draft 待所有者确认）
- [ ] CI 产出 .msi/.exe 与 .dmg 并附到 GitHub Release draft → 所有者在 GitHub 确认发布（运行约 10~20 分钟）
- [ ] 新机器按 README 从零到跑通无歧义（待人工）
- [x] 全部 learning 文档通过「复盘自测」结构完整性检查（9/9，2026-11-03）
- [x] 图标全套（gen-icon.mjs + tauri icon）+ NSIS 简体中文/per-user 配置 + 本地打包双产物验证（2026-11-03）

---
## v0.8.1 — 安装与首启体验（补丁）

**目标**：补齐用户接触产品的头 5 分钟——安装器中文、装完有可照做的说明、首次启动有引导。
不新增能力，只修"第一次用"的断点。

**步骤**：
1. NSIS 单语言简体中文（`languages: ["SimpChinese"]`、关闭语言选择框）
2. `installerHooks` 在安装完成后落一份中文「快速上手.txt」（六节：位置/手势/配 Key/能力/素材/数据）
3. 应用内首启引导 `WelcomeGuide`（四步 + 去配置 Key/先逛逛），`onboardingDone` 落 settings
4. 首启延迟 1.2s 自动打开聊天窗；设置页提供「重新显示新手引导」

**验收标准**：
- [x] `makensis` 编译含真实 hooks 的安装器通过；静默安装后 `快速上手.txt` 为 UTF-16LE 中文无乱码（2026-11-03）
- [x] `pnpm check` / `pnpm test` 46/46 / `pnpm build` 通过（2026-11-03）
- [x] 2026-11-04 基础功能检查：修复 SQL execute 能力缺失、站立弹窗超时/单击未隐藏、无关配置重置、状态互相覆盖、番茄钟缓存回报、待办写入失败内存不一致；新增 42 项测试，全量 88/88 通过（详见本版实施记录追加章节）。
- [x] 2026-11-04 稳定性第二批：原生节拍/正文队列、投递重试、未确认提醒重启恢复、服务生命周期、手势隔离、SVG尺寸/坏图回退、顺序显式写盘；全量140/140 + check/build通过，Playwright前端走查通过。新增双平台非发布check CI，原生验收仍未完成，见本版记录。
- [x] 第二批收尾复核：补弹窗成功回执晚于stop的代号检查，回归先红后绿，全量141/141通过；3155ecf已推送并触发双平台check，原生界面验收不因CI而勾选。
- [x] 最终代码5ecc73a：check run 41797319856 的Windows/macOS前端检查与Rust库测试均成功（141项TS、6项Rust）；修复macOS旧Builder API与user-idle依赖E0432。原生GUI/通知/拖动/托盘/多屏/休眠效果仍待真机验收。
- [x] 用户指定称呼设置（2026-11-04）：新增「ta自称」（默认麻薯）/「ta对我的称呼」（默认人），旧配置补默认、持久化、下一轮system提示接入；146项测试与check/build通过。保持v0.8.1，不提前进入下一里程碑。
- [x] 用户指定单击气泡（2026-11-04）：144条12类文案，按本地时段/番茄钟/活动段/回来/连续摸摸选句，最新称呼+近期去重；7秒展示与动画、异步取消和旧手势隔离；179项测试、check/build和浏览器实际窗口走查通过，原生效果仍待验收。说明见docs/pet-chatter.md。
- [x] 完整 `pnpm tauri build` 产出双包：NSIS 2.48 MiB / MSI 3.45 MiB（2026-11-03 Agent 侧后台构建两次通过，v0.8.1 文档记录的沙箱 `reg.exe` 阻断未复现）
- [ ] 实装走查：向导逐页中文步骤文案（含完成页素材规则）+ 首启引导交互闭环（待用户）

---
## v0.8.2 — 稳定性与陪伴体验发布（补丁）

**目标**：2026-11-04用户明确要求推送部署，将已完成的稳定性、称呼和点击气泡打包发布；不重写v0.8.1标签，不进入下一里程碑。细节见 `docs/versions/v0.8.2-稳定性与陪伴体验发布.md`。

**验收标准**：
- [x] 四处应用版本对齐0.8.2，功能代码保留已完成的179项测试与浏览器走查。
- [x] main双平台check成功后推送v0.8.2标签（dd8f526；check run 41801154630，179项TS与6项Rust，2026-11-04）。
- [x] release工作流完成并核对Windows/macOS草稿安装包（run 41801504464双平台success；exe/msi/universal dmg/app.tar.gz已上传，2026-11-04）。
- [ ] 新安装包真机交互走查（不以CI构建代替）。
- [ ] 所有者确认草稿并公开发布（沿用项目draft流程）。

---

## v0.9.0 — 从「能用」到「好用」（施工完成，待真机走查）

**定位**：不新增赛道，把已有能力的体验做透。完整施工单（问题清单 / 分批计划 / 验收 / 纪律）见
**`docs/iterations/2026-11-03-通宵迭代施工单.md`**，执行事实见 `docs/versions/v0.9.0-体验打磨.md`。

**范围（按施工单编号）**：
- P0：外链打开、设置落盘防抖、通知权限、宠物窗位置持久化、macOS 说明、关于/版本入口
- P1：宠物气泡、右键菜单信息密度、托盘状态、聊天流式 Markdown、工具/错误文案人话化、
  消息复制重试、稍后提醒、快捷键、开机自启、宠物大小
- P2：CI 质量门禁、代码异味（P2-01 暗色模式明示未做，留 backlog）
- 本次追加：`run_here/windows`、`run_here/mac` 安装入口、统一打包收集命令与设置首屏的手动版本检查/下载/覆盖安装指引（2026-11-06）。

**验收标准**（收口时勾选）：
- [x] 施工单 Night 1~3 完成，Night 4 至少完成快捷键与自启（实际 Night 1~5 全部完成，2026-11-05）
- [x] `pnpm test` ≥ 70 例全绿；新增设置/计时/文案表单测（85 例，2026-11-05）
- [x] 合并远程 v0.8.2 稳定线 + 手感优化 + 健康知识库扩展（2026-11-06~08）：合并提交 00a416f
      双平台 CI 绿（run 42062844666）、交互手感（点击零延迟反馈/唤回过渡/动画补全）、
      食物数据集 178 条 + 健康问答 RAG（47 条部委指南语料、search_health_advice 工具、
      引用合同与诊疗边界）；242/242 tests + cargo test 6/6（检测报告见版本文档）
- [x] `pnpm test` ≥ 70 例全绿；设置/计时/文案与更新服务共 259 例全过（2026-11-06，追加会话）
- [x] 安装目录与收集脚本落地；同版收集、SHA-256、重复替换和旧包清理边界自动验证（2026-11-06）。
- [x] 手动版本检查、正式版过滤、SemVer、分平台下载、错误重试与数据保留指引落地（2026-11-06）。
- [x] 本次追加改动的 Windows NSIS/MSI 已由 `pnpm package` 生成到 `run_here/windows`，内部版本 0.9.0 与 SHA-256 清单核验通过（2026-11-06）。
- [x] 本次追加改动的 macOS universal DMG 已由授权 CI 生成并归档到 `run_here/mac`，SHA-256/DMG 完整性/内部 0.9.0 版本与 x86_64+arm64 双架构通过（run 42171955956，2026-11-06）。
- [ ] 本次新安装器的真机覆盖安装、数据保留与原生体验验收（不能由构建成功代替）。
- [x] 用户授权后已推送 main；双平台 check/release 均 success，v0.9.0 更新说明已保存为草稿，安装包已下载核验；未公开发布（2026-11-06）。
- [ ] 安装包重新打包 + 真机全链路走查（装 → 引导 → 配 Key → 对话 → 番茄钟 → 提醒）
      ——打包已完成（三次里程碑构建），**真机走查待用户**
- [x] CHANGELOG / roadmap / learning 文档与代码一致（2026-11-05 收口核对；健康扩展同批更新）

---

## v0.9.1 — 设置项「开机自动打开」与首启事件时序修复（补丁）

**定位**：v0.9.0 收口后的补丁版本，只做用户当次提出的三件事，不扩赛道。
细节见 `docs/versions/v0.9.1-开机自动打开.md`。

**范围**：
- 设置项「开机自启」升级为「开机自动打开」：语义文案明确、系统真值回显、可「重新应用」。
- Rust 回执 `state://autostart-state` + `get_autostart_enabled` 命令。
- 修复打包版首启 `state://` 事件丢失（原生节拍兜底重放），连带修好快捷键/宠物大小首启不生效。

**验收标准**：
- [x] `pnpm check` 通过；`pnpm test` 318/318 全绿（新增自启提示纯函数 6 例，2026-11-17）。
- [x] `cargo check` 通过（仅既有 dead_code 警告）；`pnpm tauri build` 产出 NSIS/MSI，
      版本 0.9.1，归档 `run_here/windows/`。
- [x] 真机端到端（打包版，非 dev）：首启 t+1s 写入 `HKCU\...\Run`；关闭后重启 t+1s 移除；
      `get_autostart_enabled` 与注册表一致（2026-11-17）。
- [x] 打包版启动冒烟：三窗口正常加载、进程常驻（CDP 复核）。
- [ ] 设置页三态提示的视觉走查与「重新应用」点击验证（需用户本人确认）。
- [ ] 安装包在本机的覆盖安装实测（用户自行决定何时安装）。

---

## v0.9.2 — 素材导入页（双语 + 导入即改英文名）（补丁）

**定位**：v0.9.1 之后的补丁，把"自定义素材只能手写英文文件名"的隐性门槛补上一个页面。
细节见 `docs/versions/v0.9.2-素材导入页.md`。

**范围**：
- 聊天窗新增「素材 / Pet assets」Tab：十个状态的双语说明 + 当前已有张数。
- 选图 → 确认列表（原文件名 → 目标英文名 + 状态下拉）→ 落盘；中文名识别（开心 → happy）。
- 落盘统一英文规范名 `{state}[_N].{ext}`，序号避让、绝不覆盖；Rust 侧校验状态/扩展名/大小。

**验收标准**：
- [x] `pnpm check`、`pnpm build` 通过；`pnpm test` 328/328 全绿（新增 10 例）。
- [x] `cargo test` 13/13 全绿（新增 base64 与变体序号 3 例）。
- [x] `pnpm tauri build` 产出版本 0.9.2 的 NSIS/MSI 并归档 `run_here/windows/`。
- [x] 打包版端到端（CDP 驱动）：三个中文名文件 → `happy.png` / `happy_2.png` / `happy_3.png`，
      磁盘核对通过，宠物实际渲染导入图（asset 协议 URL，1×1 测试图）。
- [ ] 真机视觉走查（双语排版、长文件名省略、窄窗换行）——需用户本人确认。

---

## v0.10.0 — 活起来 · 有礼貌 · 有手感

**定位**：按「作为桌宠缺什么」的体检结论，先补最伤体验的三块（动画 / 免打扰 / 吸附），
不改 AI 与提醒主线的范围。细节见 `docs/versions/v0.10.0-活起来与礼貌.md`。

**范围**：
- 逐帧序列：`{state}_001.png`（三位零填充）、150ms/帧、预加载、与变体互斥且不轮换。
- 素材页识别帧号：导入保留 `_001`、同帧覆盖、批量提示"检测到帧序列"。
- 拖拽结束贴边吸附（24 物理 px，工作区边界，支持负坐标副屏）。
- 免打扰时段（整点、支持跨午夜、只静默站立提醒、deadline 推到时段结束）。

**验收标准**：
- [x] `pnpm check` / `pnpm build` 通过；`pnpm test` 337/337（新增静默 8 例 + 帧号 4 例）。
- [x] `cargo test` 14/14（新增吸附 1 例）。
- [x] `pnpm tauri build` 产出版本 0.10.0 的 NSIS/MSI 并归档 `run_here/windows/`。
- [x] 帧序列真机（打包版 + CDP）：三帧按 001→002→003→001 循环，采样覆盖全部帧。
- [x] 免打扰真机（打包版 + CDP，间隔临时 1 分钟）：静默组 80s 不弹；对照组 +60s 触发。
- [ ] 贴边吸附真机手感（需真实拖拽，脚本无法模拟 OS 级拖动）。
- [ ] 帧序列观感、设置项排版等视觉走查（需用户本人确认）。

---

## v0.11.0 — 休眠与锁屏（P0 收尾）+ 任务板

**定位**：把 P0 清单里"没有电源/锁屏事件"这条收掉，并把后续待办写进仓库供多 agent 认领。
细节见 `docs/versions/v0.11.0-休眠与锁屏.md`，待办见 `docs/tasks/TASKS.md`。

**范围**：
- 原生节拍带 `{ gap_ms, locked }`；≥5s 判恢复、≥5min 判长休眠。
- 锁屏视为离开（立刻 away，不等 5 分钟空闲）；恢复后活动段从零重算。
- 长休眠恢复时积压提醒**合并为一条**（不连弹），文本进聊天历史。
- `docs/tasks/`（README + TASKS + 7 个任务文件）与 `AGENTS.md` 第 4 条铁律。

**验收标准**：
- [x] `pnpm check` / `build` 通过；`pnpm test` 344/344（新增 7 例）；`cargo test` 14/14。
- [x] `pnpm tauri build` 产出版本 0.11.0 的 NSIS/MSI 并归档 `run_here/windows/`。
- [x] 合并交付端到端（打包版 + CDP）：3 条过期提醒 → 1 条「3 条提醒到点了」。
- [ ] 真实合盖/锁屏验证（需用户配合，脚本无法模拟系统电源状态）。
- [ ] 任务板可读性走查。

---

## v0.12.0 — P0 收尾：拖拽惯性与音效

**定位**：把任务板上的 P0 清空。细节见 `docs/versions/v0.12.0-P0收尾-惯性与声音.md`。
**范围**：
- 拖拽惯性：松手测速 → 干摩擦滑行 → 撞工作区边缘停 → 收尾贴边；重新抓起即取消。
- 音效：点击 + 三类提醒音，Web Audio 合成（零音频资源），设置可关可调；点击音不受免打扰。
- TTS 因需先定方案，拆为任务 P1-03。

**验收标准**：
- [x] `pnpm check` / `build` 通过；`pnpm test` 352/352（新增 8 例）；`cargo test` 16/16（新增 2 例）。
- [x] `pnpm tauri build` 产出版本 0.12.0 的 NSIS/MSI 并归档 `run_here/windows/`。
- [x] 音效链路（打包版 + CDP）：点击创建 1 个 AudioContext；关闭开关后创建 0 个。
- [ ] 惯性真机手感（需真实拖拽；参数在 `lib.rs` 的 `INERTIA_*` 常量）。
- [ ] 音效听感与音量主观验收。

---

## v0.13.0 — 提醒闭环：周期提醒与待办到期

**定位**：P1-01。让"每天吃药"这类最常见诉求可用，并让待办的到期真正会响。
细节见 `docs/versions/v0.13.0-提醒闭环.md`。

**范围**：
- 提醒 `repeat`：none / daily / weekdays / weekly，触发后自动排下一次（插新行，保留历史）。
- 待办 `due_at`：到点弹一次「待办到期」（`due_notified_at` 条件认领，幂等）。
- 工具层同步（`create_reminder.repeat`、`add_todo.due_at`）；待办页可设到点提醒、番茄钟页显示周期标签。
- DB 幂等迁移（`ensureColumn`）。

**验收标准**：
- [x] `pnpm check` / `build` 通过；`pnpm test` 361/361（新增 9 例）；`cargo test` 16/16（无 Rust 改动）。
- [x] `pnpm tauri build` 产出版本 0.13.0 的 NSIS/MSI 并归档 `run_here/windows/`。
- [x] 旧库迁移：启动后新增四列（打包版实测）。
- [x] 周期提醒端到端：过期 60s 的 daily 提醒触发一次并插入次日同时刻的新行。
- [x] 待办到期端到端：过期待办 `due_notified_at` 写入（只交付一次）。
- [ ] 真机 UI 走查（到点提醒输入框、逾期标色、周期标签）。

---

## 后续候选（Backlog，不在当前承诺内）

- ~~`{state}_001.png` 帧序列动画支持~~（✅ 已于 v0.10.0 实现）；鼠标点击物理反馈；~~宠物拖拽惯性~~（✅ 已于 v0.12.0 实现）
- VectorRetriever 落地（本地 ONNX bge-small-zh），RAG 升级混合检索
- 更多提供商预设（~~GLM/通义~~ ✅ 已于 v0.9.0 自迭代加入，见 presets.ts）；本地 Ollama 一键检测（需放行 CSP connect-src 到 localhost，暂缓）
- 待办与系统日历联动；站立提醒统计报表
- ~~提醒触发消息写入聊天历史、番茄钟离开时长统计~~（✅ 已于 v0.9.0 实现，见版本文档「learning/08 挂起项兑现」章节）
- 原生自动更新（下载、校验、安装与重启）：需要另行配置签名密钥与发布清单，本次按用户选择保留手动覆盖安装。
