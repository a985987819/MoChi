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
# 0) 环境要求：Node 22+、pnpm（corepack enable）、Rust MSVC 工具链
#    详细安装步骤见 docs/versions/v0.1.0-环境与脚手架.md

# 1) 安装依赖
pnpm install

# 2) 开发模式运行
pnpm tauri dev

# 3) 配置 API Key
#    双击宠物打开聊天窗 → 设置 Tab → 选择提供商 DeepSeek → 粘贴 API Key
#    （没有 Key 也可以用 Mock 提供商体验全流程）
```

macOS 构建走 GitHub Actions（`git tag` 触发），见 `.github/workflows/build.yml`。

## 文档导航

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 项目工作流规范（提交纪律、部署纪律、代码规范）——**协作前必读** |
| [docs/roadmap.md](docs/roadmap.md) | 版本路线图与每版验收标准（进度事实源） |
| [docs/versions/](docs/versions/) | 每版实施记录：文件级实现细节、设计取舍、踩坑、自测 |
| [docs/learning/00-learning-path.md](docs/learning/00-learning-path.md) | **Agent 学习路线起点**：知识地图、架构总图、术语表 |
| [docs/learning/](docs/learning/) | Agent 开发学习文档：Provider 抽象 / Agent 循环 / 上下文工程 / 记忆 / RAG / Tauri |
| [docs/pet-assets.md](docs/pet-assets.md) | 宠物素材命名约定（想换自己的宠物形象看这里） |

## 技术栈

Tauri 2 · React 18 · TypeScript (strict) · Vite · SQLite (tauri-plugin-sql) · 自研 BM25 检索 · OpenAI 兼容流式协议（SSE + Function Calling）

## License

MIT
