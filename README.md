# Mochi（麻薯）🍞

> 一只住在桌面上的 AI 小麻薯：会看聊天内容切换表情，会提醒你站起来，会陪你番茄钟，会帮你记待办，还能告诉你巨无霸有多少热量。

跨 **Windows / macOS** 桌面宠物应用，基于 **Tauri 2 + React 18 + TypeScript**。Agent 内核（多提供商对话、工具调用、记忆、RAG）全部在 TypeScript 层实现，本项目同时是一份**可运行的 Agent 开发教材**。

## 功能一览

| 功能 | 说明 |
|---|---|
| 🐾 桌宠 | 透明置顶小窗，图片命名约定驱动状态切换（`idle.png` / `happy.gif` / `focus.png` …），放入自己的图片即生效 |
| 💬 AI 对话 | 用户自带 API Key，支持 DeepSeek 预设（OpenAI 兼容协议，可扩展 Kimi / 硅基流动 / Ollama 等） |
| 🧠 记忆 | 会话历史持久化（SQLite）+ 短期滑动窗口 + 长期事实记忆（对话里说"记住…"即可） |
| 🍔 热量查询 | 内置麦当劳/肯德基等快餐营养数据集，BM25 检索（RAG）+ 回答引用条目 |
| ✅ 待办 | 自然语言布置待办（"帮我加个待办，明早九点交周报"） |
| ⏰ 站立提醒 | 久坐 1 小时弹窗提醒，点击弹窗重置计时；单击宠物随时重置 |
| 🍅 番茄钟 | 25/5 可配置，专注时宠物自动进入 `focus` 状态 |

## 快速开始（Windows）

```bash
# 0) 环境要求：Node 22+、pnpm、Rust MSVC 工具链 + VS Build Tools + Windows SDK
#    详细安装步骤见 docs/versions/v0.1.0-环境与脚手架.md
#    （本仓库 Windows 构建统一走 scripts\vsenv.cmd，自动加载 MSVC 环境）

# 1) 安装依赖
pnpm install

# 2) 开发模式运行
scripts\vsenv.cmd pnpm tauri dev

# 3) 配置 API Key
#    双击宠物打开聊天窗 → 设置 Tab → 选择提供商 DeepSeek → 粘贴 API Key
#    （没有 Key 也可以选 Mock 提供商体验全流程）
```

## 首次打开（macOS）

Mochi 的 macOS 包**未签名公证**，首次打开会被 Gatekeeper 拦下（提示"无法打开，
因为无法验证开发者"）。两种放行方式任选其一：

1. **右键 → 打开 → 再点「打开」**（推荐，无需命令行）；
2. 或解除隔离属性后正常打开：

```bash
xattr -dr com.apple.quarantine /Applications/Mochi.app
```

> 出现这个提示不是包损坏，而是没有开发者签名的应用的默认待遇。
> 应用内「设置 → 关于」可查看版本与数据目录，遇到问题可把诊断信息贴进 issue。

## 打包与发布

```bash
# Windows 本地打包（NSIS 简体中文安装器 + MSI）
scripts\vsenv.cmd pnpm tauri build
# 产物：src-tauri/target/release/bundle/{nsis,msi}/

# 应用图标：scripts/gen-icon.mjs 生成源图 → tauri icon 出全尺寸
node scripts/gen-icon.mjs && pnpm tauri icon app-icon.png
```

**发布（部署纪律）**：push tag `v*` 触发 GitHub Actions 双平台构建（Windows NSIS/MSI +
macOS universal .dmg，未签名），自动附到 GitHub Release（draft）。**发布必须由项目所有者
显式声明执行**（见 AGENTS.md），工作流定义见 `.github/workflows/release.yml`。

## 用户数据

运行数据全部在本机：`{应用数据目录}/com.mochi.pet/`（SQLite mochi.db + settings.json +
pet-assets/ 自定义素材）。卸载重装/升级均保留；"清空聊天历史"在设置页。

## 文档导航

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 项目工作流规范（提交纪律、部署纪律、代码规范）——**协作前必读** |
| [docs/roadmap.md](docs/roadmap.md) | 版本路线图与每版验收标准（进度事实源） |
| [CHANGELOG.md](CHANGELOG.md) | 按版本的叙事记录：变更 / 动机与取舍 / 学习要点 / 版本规划影响 |
| [docs/versions/](docs/versions/) | 每版实施记录：文件级实现细节、设计取舍、踩坑、自测 |
| [docs/learning/00-learning-path.md](docs/learning/00-learning-path.md) | **Agent 学习路线起点**：知识地图、架构总图、术语表 |
| [docs/learning/](docs/learning/) | Agent 开发学习文档：Provider 抽象 / Agent 循环 / 上下文工程 / 记忆 / RAG / Tauri |
| [docs/pet-assets.md](docs/pet-assets.md) | 宠物素材命名约定（想换自己的宠物形象看这里） |

## 技术栈

Tauri 2 · React 18 · TypeScript (strict) · Vite · SQLite (tauri-plugin-sql) · 自研 BM25 检索 · OpenAI 兼容流式协议（SSE + Function Calling）

## License

MIT
