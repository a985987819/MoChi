# 更新日志（Changelog）

> 本文件按版本沉淀「变更 → 动机 → 学习要点 → 规划影响」的叙事，服务两个目的：
> 1. **理解项目**——每版为什么这么做、学到了什么；
> 2. **版本规划**——每版给后续版本埋了什么伏笔、加了什么约束。
>
> 粒度约定：按版本记录；单次会话内的多个 commit 见 git log（提交正文同样遵循结构化模板，见 `AGENTS.md` 提交纪律）。
> 文件级实施细节在 `docs/versions/`，本文不重复，只做"高层叙事 + 链接"。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号见 `docs/roadmap.md`。

---

## [Unreleased] — v1.0 发布清单

**已发布**（2026-11-03，用户显式声明）：remote github.com/a985987819/MoChi.git；main + tag v0.8.0 已推送。
**v0.8.0 CI 复核结论**（2026-11-03 22:26 复查 Actions）：Windows job **成功**（`tauri-apps/tauri-action` 产出
NSIS/MSI 并创建 draft Release）；macOS job **失败**——`构建并发布` 步骤报
`Command "pnpm tauri build --target universal-apple-darwin" failed with exit code 1`
（run 41555740912，3m31s 失败；job 日志需仓库 admin 权限，匿名 API 拿不到，暂无法定位到具体子命令）。
**剩余事项**：①定位 macOS 构建失败（优先怀疑无 GUI 环境下 `.dmg` 打包的 Finder/AppleScript 步骤）→ 修复后重跑；
②在 GitHub 确认 draft Release；③新机器按 README 复跑；④日常使用反馈。

**v0.8.0 完善批次**：版本号三处对齐 0.8.0（tag 与应用版本一致）；release.yml 补 pnpm install --frozen-lockfile（tauri-action 不装依赖）；**安装实测自动化通过**（静默装→跑→卸→重装，mochi.db 全程保留），应用已安装在机器上。

---

## [v0.8.1] - 2026-11-03 — 安装与首启体验（补丁）

### 2026-11-04 桌宠与提醒稳定性第二批

- **变更**：手势区分单双击/拖动、菜单事件隔离、SVG尺寸与坏图兜底；原生每秒节拍+后备检查，正文弹窗按id排队且防连点误确认；投递失败重试、数据库重连、服务生命周期清理；新增acknowledged_at恢复未确认定时提醒；设置顺序显式落盘与错误重试。
- **动机与取舍**：只依赖WebView定时器/系统通知不足以可靠交付；原生只负责唤醒和显示队列，业务计时/确认持久化仍在TS/SQLite。确认写入前硬崩溃可能再次提示，选择宁重复不漏。
- **学习要点**：真实浏览器发现0×0 SVG，必须跨过布局边界验证；去重/确认必须携带所有者id；“已入队”和“用户已确认”是不同持久状态。详见learning/08与09。
- **版本规划影响**：仍停留v0.8.1，不跳过原生验收。新增独立check CI（main/PR双平台check/test/build/cargo test，不发布），不改release流程。
- **验证**：本地21文件140/140、check/build/diff通过；Playwright动作及动态提醒走查通过（官方IPC mocks）。Rust5项测试已写，本机缺MSVC/Rust未执行；原生GUI/通知/多屏效果待实测。上一批61190d9已推送，本批推送与CI事实见实施记录。
- **收尾复核**：弹窗请求在stop后迟到成功时不再改变宠物或通知；新增失败复现与修复后回归，全量141/141，第二批累计新增53项。
- **原生检查**：首轮check CI的Windows前端与Rust测试通过；macOS cargo步骤失败后对照锁定源码发现旧Builder调用activation policy API不正确，改在setup中的App上设置，后续双平台结果见版本记录。

### 2026-11-04 基础功能回归修复（本地，未发布）

- **变更**：补 `sql:allow-execute`，保障现有 TS 建表/写入路径；站立提醒超时和单击宠物时请求隐藏弹窗，仅修改站立间隔才重新计时；宠物系统状态按服务保存，提示结束后恢复专注；番茄钟 UI/工具等待宿主回执并使用实际配置时长；待办先落库后改内存，提醒取消采用条件更新。
- **动机与取舍**：保持应用服务是唯一权威，放弃依赖聊天缓存推断启动结果、共享一个系统状态字段的实现；详见 learning/08 §2.2、§4.4.1 与 learning/04 §3.2。
- **学习要点**：发送事件不等于执行成功；共享资源必须明确清理所有权；SQL 默认能力不含写权限；异步 CRUD 的内存状态应在数据库成功后提交。
- **版本规划影响**：不进入 v0.9.0，不勾选原生验收；离开时长统计和提醒消息写入聊天历史明确为后续候选。
- **验证**：新增 42 项回归，全量 13 文件 88/88 通过；`pnpm check`、`pnpm build`、`git diff --check` 通过。当前机器缺 Rust/MSVC 且无 Mochi 窗口，原生 GUI/通知/重启持久化和真实模型联调仍待验证；详见 v0.8.1 实施记录追加章节。

### 变更
- 安装器：`nsis.languages` 收为 `["SimpChinese"]` 单语言，关闭语言选择框——英文 Windows 上也装出中文安装器；
- 新增 `src-tauri/windows/installer-hooks.nsh`（UTF-8 with BOM）：`NSIS_HOOK_POSTINSTALL` 往安装目录写
  中文「快速上手.txt」，六节覆盖"麻薯在哪 / 三个手势 / 配 Key / 能做什么 / 换形象 / 数据与卸载"；
- 应用内首启引导 `src/pages/chat/WelcomeGuide.tsx`：四步说明 + 两个出口（去配置 API Key / 先逛逛），
  `onboardingDone` 落 settings（老配置归一为 false）；首启延迟 1.2s 自动打开聊天窗；
- 设置页新增「使用指引 → 重新显示新手引导」；
- 说明文档：`docs/iterations/2026-11-03-通宵迭代施工单.md`（P0/P1/P2 问题清单 + 五夜计划 + 执行契约）。

### 动机与取舍
安装器原本是"跟随系统语言"，对中文产品来说等于随机；而 Tauri 的 NSIS 完成页文案写死在模板里，
改它要整份复制几百行 `.nsi`，跟着 Tauri 升级漂移。于是把"装完的指引"拆成两层：
安装器落一份 txt（信息全、零维护）+ 应用内首启引导（真正手把手，且能直接跳到设置配 Key）。
引导不做独立窗口，而是聊天窗内的覆盖层——少一个 WebView、少一套生命周期与焦点问题，
代价是不能在聊天窗关闭时显示（首启场景下聊天窗恰好是被自动打开的，不构成问题）。

### 学习要点
1. `languages` 数组不是"优先级"而是"系统语言匹配池"：系统语言不在池里时用**第一个**，
   所以"中文优先"的正确写法是单语言或配 `displayLanguageSelector`。
2. NSIS 脚本的编码由 BOM 决定，`Unicode true` 下无 BOM 的 UTF-8 中文会被按 ANSI 解析成乱码；
   这类"看起来能编译、跑起来全乱"的问题必须实跑一次安装器才能发现。
3. 引导状态属于"用户偏好"而非"界面状态"：放 settings 才能跨重装保留，放 localStorage 会在清缓存时丢失。

### 版本规划影响
- 头 5 分钟补齐后，体验瓶颈转移到"日常使用"：气泡、右键菜单、托盘状态、位置持久化等，
  已全部整理进施工单，作为 v0.9.0「从能用到好用」的范围。
- 自定义 NSIS 模板改完成页仍列为 P2-02：收益是最后一屏多三行话，成本是跟随 Tauri 版本维护模板。

### 验证
`pnpm check` ✅ / `pnpm test` 46 passed ✅ / `pnpm build` ✅；
`makensis 3.13` 编译含真实 hooks 的最小安装器通过，静默安装后 `快速上手.txt` 1894 字节 UTF-16LE 中文无误。
完整 `tauri build` 因沙箱阻断 `reg.exe`（vcvars 依赖）未能执行，待用户在真实终端验证。

### 发布记录
- 2026-11-03 22:26（用户显式声明"推送部署"）：版本号三处对齐 0.8.1（package/tauri.conf/Cargo.toml + Cargo.lock），
  `main` 推到 39dda4c，annotated tag `v0.8.1` 已推送。
- CI：run [41653711863](https://github.com/a985987819/MoChi/actions/runs/41653711863)，
  Windows/MSI 与 macOS dmg 双矩阵，Release 走 **draft**（由所有者确认发布）。
- 本地无法完整打包（沙箱限制），本次安装包以 CI 产物为准——这也是对 v0.8.1 中文安装器的实装验证。

---

## [v0.8.0] - 2026-11-03 — 打包分发 + CI + 文档收官

### 变更
- 应用图标：scripts/gen-icon.mjs（手写 PNG 编码器+程序化绘制 1024px 团子）→ tauri icon 19 文件全套；
- 打包：bundle targets 限定 nsis+msi，NSIS 简体中文/英文 + per-user 安装；
  本地 `tauri build` 产出 NSIS 2.49 MiB + MSI 3.45 MiB 双安装包；
- CI：.github/workflows/release.yml（tag v* 触发，windows/macos matrix，
  tauri-action 产 **draft** Release 由所有者确认；macOS universal dmg 未签名）；
- README 收官（打包/发布/用户数据三节）；build.yml→release.yml 引用统一；
  learning 9 篇复盘自测结构检查通过。

### 动机与取舍
- 手写 PNG 编码器而非引 canvas/sharp：一次性图标产物零依赖；
- NSIS 主推（简体中文+per-user），MSI 辅助（en-US 保首建可靠性）；
- CI 自动化到 draft 为止：把"对外发布"留给人工确认（07 确认回环思想的应用）；
- macOS 未签名：个人分发可接受，签名公证需 Apple Developer 账号（v2）。

### 学习要点
- Tauri 打包链：NSIS/WiX 工具链由 CLI 自动下载托管；
- 手写 PNG（IHDR/IDAT/CRC32/zlib）——理解图像格式最薄的一层；
- 发布流水线的"自动化到 draft"模式：CI 效率与人工把关的平衡点。

### 版本规划影响
- roadmap v0.1→v0.8 全部代码侧完成；v1.0 发布等人工验收 + 显式声明；
- 后续 backlog 见 roadmap「后续候选」（帧序列动画/VectorRetriever/多会话等）。

### 验证
- 双安装包产出 ✓ / 图标 19 文件 ✓ / release.yml 复查 ✓ / learning 9 篇结构 ✓；
- 安装实测与 CI 首跑待人工。

---

## [v0.7.0] - 2026-11-03 — 计时服务 + 在场检测 + 自然语言提醒

## [v0.7.0] - 2026-11-03 — 计时服务 + 在场检测 + 自然语言提醒

### 变更
- Rust：get_idle_seconds（user-idle 0.2，零权限聚合查询）、show_alert（定位宠物正上方）、
  ui://show-alert 与 ui://standup-ack 监听；+tauri-plugin-notification；
- services/timers.ts：StandupService（armed→fired→ack 闭环、away 隐式推迟、10min 超时
  收尾、单击重置消费 v0.2.0 契约事件）+ PomodoroService（focus→break→idle 不自动续轮、
  每秒广播）——时间基准三原则（时间戳/无脑 tick/唤醒补发）；
- services/presence.ts（10s 轮询+迟滞 5min→sleep 状态）、reminders.ts（Store 聊天窗 CRUD
  + Scheduler 宠物窗 30s 轮询 SQL 认领幂等、away 不认领）、notifications.ts、
  settings 扩展 4 字段（clampInt+settingsChanged 热更新）；
- reminders 第五表；pet-state.clearPresence；context-builder 注入当前时间锚点；
- 工具 +6：start/stop/get_pomodoro_status（边界校验 5~90 分钟、重复启动 ok:false）、
  create/cancel/list_reminders（时间硬校验：可解析/非过去/≤30 天；周期提醒降级话术；
  与 add_todo 描述互指）；
- UI：Alert 页实现（点击即 ack）、番茄钟 Tab（服务端数字倒计时+提醒列表）、
  四 Tab 结构、设置 TimerConfigSection。

### 动机与取舍
- 提醒调度驻留宠物窗+DB 轮询认领：单一事实源=SQLite，幂等且免跨窗口状态同步；
- StandupService 砍掉 deferred 显式态：away 不 fire 即隐式推迟，少一态语义不变；
- get_pomodoro_status 读广播缓存：chat 窗打开时每秒新鲜，避免跨窗口请求-响应；
- 通知开关统一三服务：一处开关管全部打扰面；
- 番茄钟配置热更新不影响进行中轮次（时间基准已在跑，下一轮生效）。

### 学习要点
- 时间基准三原则的完整落地体感（睡眠/节流/漂移三坑全消）；
- user-idle API 误猜 → 读 ~/.cargo/registry 源码查证（离线查依赖 API 的标准姿势）；
- 跨窗口载荷类型用宽松形状（PomodoroStatusLite）而非强 union；
- "当前时间锚点"是 LLM 做相对时间解析的唯一依据（模型不知道现在几点）。

### 版本规划影响
- v0.8.0 打包后：用户数据目录含 mochi.db/settings.json，安装升级需验证数据保留；
- AGENTS.md 部署纪律即将首次生效（tag/Release 需显式声明）。

### 验证
- 46/46 测试 ✓ / tsc ✓ / vite ✓ / cargo check ✓（user-idle 编译通过）；
- 计时/提醒/在场三条链路 6 条待人工。

---

## [v0.6.0] - 2026-11-03 — RAG 热量查询

## [v0.6.0] - 2026-11-03 — RAG 热量查询

### 变更
- 数据集 100 条（mcd 43/kfc 34/others 23，覆盖麦当劳/肯德基/汉堡王/必胜客/塔斯汀），
  字段 id/brand/name/aliases/category/serving/kcal/宏量营养素；
- rag/indexer（foodToDoc 文档化 + docToFood 还原）+ rag/synonyms（10 组同义词，
  expandQuery 幂等化 + 全小写比对）+ rag/food（FoodIndexService，构造即索引）；
- food-search 工具（risk=read，输出剥 aliases，反幻觉合同写进 description）；
- 系统提示词生长：热量边界条款（数值只能来自检索条目/注明份量/近似标注/2000kcal 基准）；
- 评测集 10 query Hit@3 门槛 ≥9（实际 10/10）；总测试 46/46。

### 动机与取舍
- 数据集 100 条而非凑满 130：数值可信度 > 条目数（宁缺勿编），扩展零成本；
- agentic RAG：检索作为工具由模型自主调用，闲聊不浪费检索；
- expandQuery 幂等 + 全小写输出：评测抓到"重复扩展"与"大小写不稳定"两个真问题；
- 比萨按 1/8 块计量：单位歧义是热量问答高频错源；
- 工具输出剥 aliases：模型自产别名无需回显（工具结果瘦身）。

### 学习要点
- 评测驱动的检索调优：两连修复全部由测试抓出（不幂等/大小写 miss）——
  "评测集就是 RAG 的考卷"从口号变成体感；
- 反幻觉的三道防线：工具 description 合同 + 系统提示边界条款 + 空结果语义；
- serving 明确到不可再分（比萨 1/8 块）是热量问答的工程细节。

### 版本规划影响
- 系统提示词已含"合计相加"指引，07 §5 的 verify_meal 工具（v2）可无缝加防线；
- v0.7.0 的 create_reminder 与 add_todo 的意图边界在两工具 description 中互指。

### 验证
- 46/46 测试（Hit@3=10/10）✓ / tsc ✓ / vite ✓ / cargo check ✓；热量问答体验 4 条待人工。

---

## [v0.5.0] - 2026-11-03 — 记忆系统：SQLite 历史 + 窗口 + 长期记忆

## [v0.5.0] - 2026-11-03 — 记忆系统：SQLite 历史 + 窗口 + 长期记忆

### 变更
- 数据层：plugin-sql（sqlite）+ db.ts ensureSchema 四表（DDL 权威定义 learning/04 §3.1）；
  TodoService 迁 SQLite（接口不变，todos.json 自动迁移）；
- 记忆层：HistoryStore（协议原样落库/按块恢复/清空）+ MemoryService（remember 落库+索引绑定/
  list/remove/searchForContext）+ core/window.ts（estimateTokens + trimWindow 按块裁剪）；
- 检索层：rag/ 三件（Retriever 接口、bigram+停用词 tokenizer、BM25Retriever k1=1.5 b=0.75）；
- 内核：runAgent +persist 回调；buildInitialMessages 泛化为 buildMessages({history,...})；
  Facade 并行取（裁剪历史∥记忆检索）→ 五层上下文 → 协议持久化闭环；
- UI：聊天历史重启恢复（toolCalls→note）；设置页记忆管理 + 清空历史（confirm+事件重载）。

### 动机与取舍
- 协议原样落库（tool_calls JSON 整存）：恢复即用，行宽代价由窗口裁剪吸收；
- 记忆索引内存重建（<10ms）：免索引持久化；
- DDL 走 TS ensureSchema 而非 conf migrations：透明可读零配置风险；
- 检索与 RAG 共用 Retriever：一套代码两处收益（04 核心主张，v0.6 兑现）；
- trimWindow 至少保一块；首条非 system 防御性原样返回。

### 学习要点
- 三层记忆（工作/情景/语义）的落地形态与"写入=落库+索引绑定"闭环；
- 窗口裁剪的协议完整性：tool 结果永远跟 tool_calls 的 assistant，成块裁剪；
- BM25 公式（k1 饱和/b 长度归一/Lucene IDF 恒正）首次亲手实现；
- plugin-sql 的 $N 参数占位符与 select/execute 分工。

### 版本规划影响
- v0.6.0 只需：数据集 JSON + 同义词 + food-search 工具 + 评测（检索栈已就位）；
- 记忆文档 docId 前缀 `mem-` 与未来 food 文档 id 空间隔离；
- v0.7.0 reminders 表新增走同一 ensureSchema 模式。

### 验证
- tsc ✓ / vite ✓ / cargo check ✓；历史恢复/记忆回忆/裁剪/迁移 5 条待人工。

### 完善（同日第二批次）
- 修复两个真实 bug：**服务就绪竞态**（runTurn 现在等待 todoService/memoryService ready，
  否则首轮检索/工具读空）、**落库乱序**（HistoryStore 串行队列，防 tool 先于 assistant 入库）；
- 测试基建：vitest + 30 用例（tokenizer/bm25/trimWindow/validate-schema）全绿，
  `pnpm test` 入驻脚本；被测模块零 tauri 依赖——分层纪律的可测性红利；
- 文档-代码同步：learning/04 §3.2（ensureSchema 实现选择）、03 §4.1（buildMessages 泛化）、
  01 §4.3（persist 回调扩展）。

---

## [v0.4.0] - 2026-11-03 — Agent 循环与工具调用（待办功能上线）

## [v0.4.0] - 2026-11-03 — Agent 循环与工具调用（待办功能上线）

### 变更
- `src/agent/tools/`：validate-schema（迷你 JSON Schema 校验器）、registry（ToolRegistry + risk 分级 + 失败回传自愈）、todo×4、pet-state（枚举精化 happy/sad）；
- `src/agent/core/`：prompt（系统提示词 v0.4 剪辑版）、context-builder（memories/retrievedKnowledge 接口预留）、agent（runAgent ≤8 步循环、allSettled 并发、hitMaxSteps 兜底）；
- `src/agent/facade.ts`：依赖组装 + thinking/talking 宠物状态映射（AgentEvent 驱动）；
- TodoService（store 持久化）+ 待办 Tab（手动增删/勾选，UI 通道）；
- ChatTab 接入 facade + 工具轨迹 note 条目（不进协议历史）。

### 动机与取舍
- 一切工具失败转 {ok:false} 回传——模型自愈是 Agent 的核心容错机制；
- set_pet_state 枚举收窄 happy/sad（08 §2 精化 01 §4.5）：能力面最小化，thinking/talking 应用驱动；
- 待办 UI 手动通道必须有：07 双入口铁律，Agent 通道故障不瘫功能；
- due 传用户原话不解析：防幻觉具体时刻，时间语义归 v0.7.0；
- note 轨迹不进协议历史：用户可感知、上下文不污染。

### 学习要点
- Agent = LLM + 循环 + 工具 + 状态：runAgent 60 行的四个步骤与两个终止出口；
- 协议顺序铁律：tool 结果紧跟 tool_calls 所在 assistant，裁剪按块；
- 参数校验在代码侧：模型输出只是"建议"；
- 双错误通道：transport 抛出、工具级回填自愈。

### 版本规划影响
- v0.5.0：runAgent 内 SQLite 同步点已注释；buildInitialMessages 的 memories 入参直接接 MemoryService；
- todos.json → SQLite 迁移时 TodoService 接口保持不变（双入口无感切换）。

### 验证
- tsc ✓ / vite ✓ / cargo check ✓；对话驱动待办/情绪联动/自愈 5 条待人工（需真实 Key）。

---

## [v0.3.0] - 2026-11-03 — Provider 抽象与流式对话

## [v0.3.0] - 2026-11-03 — Provider 抽象与流式对话

### 变更
- `src/agent/providers/`：LLMProvider 接口、SSE 解析器、OpenAI 兼容实现（tool_calls 增量拼接/错误分类/连接重试/AbortSignal）、五提供商预设、MockProvider、工厂；
- 设置服务（plugin-store：每提供商独立 Key/模型桶）+ 设置 Tab（提供商/Key/模型/连通性测试含首字延迟）；
- 聊天 Tab：流式渲染（流式纯文本 + 完成后 markdown）、流式光标、停止按钮、错误条；
- 聊天窗自绘标题栏（decorations:false）+ Tab 结构；Rust + store 插件。

### 动机与取舍
- 自写 fetch 弃 SDK（教学 + 零依赖，learning/02 既定裁决）；
- 连接阶段可重试、流阶段绝不重试（避免重复输出）；
- 流式纯文本 + 完成后 markdown（逐帧 remark 开销大、光标难贴合）；
- 无 Key 闸门在发送前（isProviderReady）——错误前置到动作前；
- 设置即时落盘，无"保存按钮"，表单与持久值永不漂移。

### 学习要点
- SSE 逐字节解析与 tool_calls 增量拼接（index 分组 + arguments 累加）；
- 差异是数据不是逻辑：新增提供商 = presets 加一行；
- AbortSignal 贯穿 + AbortSignal.any 合并超时；
- "模型无状态，历史全量重发"在 UI 数据流里的直接体现。

### 版本规划影响
- v0.4.0 AgentRunner 直接消费本版 StreamEvent/ChatMessage/ToolCall 类型；serializeMessage 已支持 tool 角色；
- settings.ts 结构预留 v0.7.0 计时器配置字段；
- MockProvider 脚本队列将用于 v0.4.0 工具循环联调。

### 验证
- tsc ✓ / vite ✓ / cargo check ✓；真实 Key 流式对话/错误分类/Key 持久化 3 条待人工。

---

## [v0.2.0] - 2026-11-03 — 宠物状态系统：命名约定 + PetStateManager

## [v0.2.0] - 2026-11-03 — 宠物状态系统：命名约定 + PetStateManager

### 变更
- `docs/pet-assets.md` 约定定稿（目录优先级 / 命名规则 / 10 状态集 / 验收指引）；
- PetStateManager：三槽位仲裁（system > presence > mood > idle）+ 超时回落 + `state://pet-changed` 广播 + 跨窗口遥控事件；
- 素材解析器：用户目录（Rust 窄命令 + asset 协议）> 内置 10 状态 SVG 集 > 占位 SVG 兜底；每次解析重扫用户目录（放图即生效）；
- 变体轮换（静态图 5~9s 随机、动画图不轮换）；自绘右键菜单（含表情演示验收工具）；
- 单击宠物 emit `ui://reset-standup`（契约先行，v0.7.0 接计时器）。

### 动机与取舍
- 每次解析重扫目录而非文件 watcher：毫秒级 readdir 换"放图即生效"，省掉 notify 事件桥；
- 自定义窄命令而非 tauri-plugin-fs：前端不持通用文件权限，最小权限面；
- SVG 手绘替代脚本生成 PNG（roadmap 原步骤）：质量更高、体积更小、零构建工具；
- 仲裁（pet-state.ts）与渲染（PetApp）分离：状态不知道图片、图片不知道优先级。

### 学习要点
- 资源"文件名即协议"设计与三层回退链；Tauri asset 协议与 capability 联动（protocol-asset feature）；
- Rust/TS 双份约定实现的同步纪律（parseAssetName ↔ pet_state_of_file_name）；
- AppHandle move 语义（E0382）与 clone 惯例；tauri feature ↔ conf 校验机制。

### 版本规划影响
- v0.4.0 `set_pet_state` 工具直接 emit `state://set-mood`，零新协议；
- v0.7.0 只需给 `ui://reset-standup` 加 Rust 监听 + 驱动 system/presence 槽，前端状态系统零改动；
- 状态名扩展必须同步 pet-assets.md + 两侧解析实现。

### 验证
- tsc ✓ / vite ✓ / cargo check ✓（0 警告）；4 条素材回退/轮换/优先级验收待人工（docs/pet-assets.md §5）。

---

## [v0.1.3] - 2026-11-03 — 设计：宠物状态机 / 在场检测 / 计时 / 自然语言提醒

### 变更
- 新增 `docs/learning/08-timers-reminders-presence.md`；roadmap v0.7.0 范围扩展（+在场检测 +NL 提醒，验收 7 条）；07 灰色地带"对话设提醒"转正；00 知识地图 +1。

### 动机与取舍
- 在场检测只采信"距上次输入时长"（OS 轮询 API），**拒绝键盘事件流**（rdev 类）——隐私红线一票否决。
- 承认信号局限：idle = 在场性 ≠ 忙碌（读纸质书反例），因此站立计时不因离开暂停、只推迟弹窗。
- `thinking`/`talking` 由应用从 AgentEvent 映射，不让模型自己调工具——减少无意义工具调用。

### 学习要点
- 时间基准三原则（时间戳 / 无脑 tick / 唤醒补发一次）如何同时化解 WebView 节流与系统睡眠两个坑。
- 宠物状态优先级链 `alert > focus/break > sleep > mood > idle` 的每一条为什么。
- NL 提醒的四跳责任链：模型只做"时间理解"，校验/调度/持久化/触发全在应用。

### 版本规划影响
- v0.7.0 范围从 2 个服务扩为 4 项（+Presence +Reminder），验收 4→7 条；
- v0.2.0 的状态集与槽位仲裁按 08 §2 落地，PetStateManager 预留 presenceSlot；
- v0.4.0 的 facade 增加 AgentEvent→thinking/talking 映射；context-builder 预留当前时间注入；
- 新 backlog：`verify_meal`（合计校验）、周期提醒、前台窗口嗅探（均 v2，见 07/08）。

---

## [v0.1.2] - 2026-11-03 — 架构裁决：Agent 与桌面应用的边界

### 变更
- 新增 `docs/learning/07-agent-vs-app-boundary.md`；00 知识地图 +1；AGENTS.md 新增"功能归属裁决"条款。

### 动机与取舍
- 判据体系：八条量化判据，确定性/错误代价/安全为一票否决；
- 核心铁律：意图层可归 Agent，**执行层走应用 Service（工具=薄封装），存储层 100% 应用**；
- 双入口模式：UI 与 Agent 工具汇入同一 Service——Agent 通道故障不瘫核心功能。

### 学习要点
- 四问决策树；"Agent 提议、应用裁决"（情绪优先级、参数校验、确认回环）；
- 反模式六条（让 Agent 计时等待、直写库、高频交互走 LLM、状态副本、长算术、输出直执行）；
- 新工具上线前六项自查表。

### 版本规划影响
- v0.4.0 工具定义增加风险分级（read/write/destructive）；
- v0.6.0 backlog 增加 `verify_meal`；
- 新功能入清单前必过 07 §2 判定流程——这是所有后续版本的常设门槛。

---

## [v0.1.1] - 2026-11-03 — 学习文档体系 00–05（文档先行）

### 变更
- 一次性交付 6 篇学习文档（00 路径总览 / 01 循环 / 02 Provider / 03 上下文 / 04 记忆 / 05 RAG）+ 版本记录；roadmap 标注"文档先行"约定。

### 动机与取舍
- 文档先行的理由：接口、预算、表结构、算法参数先定稿，代码只是规范的执行——不一致即 bug；
- TS 全覆盖（async generator / 判别联合 / AbortSignal），零 Python 依赖；
- 每篇以「复盘自测」收尾，作为对应版本的开工门槛。

### 学习要点（各文档一句话）
- 02：LLM API 就是一个 HTTP 调用；SSE 逐字节解析与 tool_calls 增量拼接是最大坑；
- 01：Agent = 60 行循环（LLM↔工具直到无调用）；错误回传实现模型自愈；
- 03：上下文是预算问题；系统提示词全文逐段动机；裁剪必须保 tool 配对完整性；
- 04：三层记忆（工作/情景/语义）；"写入=落库+索引"必须绑定；
- 05：BM25 公式逐项吃透；中文 bigram + 同义词；RAG 必须配评测集（Hit@3≥9/10）。

### 版本规划影响
- v0.3.0–v0.6.0 的实现规格全部锁定（事件协议/上下文预算/四表 DDL/BM25 参数）；
- 开工流程固定：读文档 → 过自测 → 写代码 → 对照文档核对。

---

## [v0.1.0] - 2026-11-03 — 环境与脚手架：三窗口 + 托盘骨架

### 变更
- 环境：pnpm 12.16 / MSVC 14.44 / Windows SDK 26100 / Rust 1.99.1；
- Tauri 2 + React 18（多入口 pet/chat/alert）、托盘、单实例、关闭=隐藏、宠物右下角定位、SVG 占位形象；
- 文档：AGENTS.md（工作流铁律）、roadmap（v0.1.0→v0.8.0）、learning/06、versions/v0.1.0；
- `scripts/vsenv.cmd`（Windows 构建环境包装）。

### 动机与取舍
- 窗口管理全收归 Rust（事件驱动 `ui://` 协议）——权限最小化 + 逻辑单一来源；
- 关闭=隐藏、托盘退出——常驻应用通行生命周期；
- chat 暂用系统标题栏（v0.3.0 升级自绘）；宠物定位 v1 接受悬浮任务栏。

### 学习要点
- Tauri 的进程/窗口/能力模型（非 Electron）；透明窗口三件套（transparent + CSS + shadow:false）；
- 物理像素 vs 逻辑像素（margin×scale_factor）；
- Windows 环境三坑：Git Bash link.exe 遮蔽（→vsenv）、SDK 幽灵 MSI 注册（→卸载重装）、VS 安装器 --quiet/--passive 必须提权（Exit 5007）；
- Rust 变量遮蔽函数（E0618 报错位置迷惑）；tauri feature 与 conf 联动（macos-private-api）。

### 版本规划影响
- 确立 `scripts\vsenv.cmd` 为全部 Windows 构建入口（AGENTS.md 环境备忘）；
- 宠物窗为事实主窗口（常驻），为 v0.7.0 计时服务驻留奠基；
- `ui://`/`state://` 事件命名约定为后续所有窗口通信立规。

### 验证
- tsc ✓ / vite 三入口 ✓ / cargo check（0 警告）✓ / cargo build ✓（mochi.exe 13MB）；
- GUI 人工验收待本机执行（宠物窗/托盘/双击开聊天/单实例）。
