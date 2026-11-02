# 更新日志（Changelog）

> 本文件按版本沉淀「变更 → 动机 → 学习要点 → 规划影响」的叙事，服务两个目的：
> 1. **理解项目**——每版为什么这么做、学到了什么；
> 2. **版本规划**——每版给后续版本埋了什么伏笔、加了什么约束。
>
> 粒度约定：按版本记录；单次会话内的多个 commit 见 git log（提交正文同样遵循结构化模板，见 `AGENTS.md` 提交纪律）。
> 文件级实施细节在 `docs/versions/`，本文不重复，只做"高层叙事 + 链接"。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号见 `docs/roadmap.md`。

---

## [Unreleased] — 下一版 v0.4.0

**范围**：ToolRegistry + AgentRunner（规格 learning/01）+ 上下文工程/系统提示词（learning/03）+ set_pet_state / todo_* 工具 + 待办 Tab（内存版，v0.5.0 迁 SQLite）+ 宠物情绪联动。
**前置**：v0.3.0 人工验收（真实 Key 流式对话）。

---

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
