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
| 🔄 版本更新 | 设置页手动检查公开正式版，查看更新说明并下载对应系统安装包，覆盖安装保留用户数据 |

## 直接安装

不需要开发环境时，从根目录的 [run_here/](run_here/README.md) 找安装包：

- **Windows**：[run_here/windows/](run_here/windows/README.md)，优先运行 `Mochi_版本_x64-setup.exe`，或任选 `.msi` 安装。
- **macOS**：[run_here/mac/](run_here/mac/README.md)，打开对应芯片架构的 `.dmg`，把 Mochi 拖入 Applications；`universal` 同时支持 Intel 与 Apple Silicon。

安装包由对应平台构建生成，不提交 Git；刚克隆仓库时可能只有目录说明。各目录的 `manifest.json` 在生成后记录版本、大小与 SHA-256。Windows 无法本地生成 macOS 包，不能以目录已存在视作安装包已就绪。

装好后双击宠物打开聊天窗，在「设置」配置提供商与 API Key；也可以选 Mock 提供商先体验。

## 开发运行（Windows）

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

Rust 安装在自定义磁盘时，可在被 Git 忽略的 `scripts/vsenv.local.cmd` 中配置本机 `CARGO_HOME`、`RUSTUP_HOME`；已有环境变量优先，配置仅影响包装脚本内的子进程。示例见 [项目结构](docs/project-structure.md#本机-windows-工具路径)。

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
# 推荐：本机构建并将安装文件整理进 run_here/windows 或 run_here/mac
# Windows 自动走 scripts\vsenv.cmd；macOS 默认构建本机架构
pnpm package

# Mac 上构建通用包，需预先安装 aarch64/x86_64 两个 Rust target
pnpm package --target universal-apple-darwin

# 底层命令仍可单独执行（Windows：NSIS 简体中文安装器 + MSI）
scripts\vsenv.cmd pnpm tauri build
# 再将 src-tauri/target/release/bundle/{nsis,msi}/ 里的当前版本包整理出来
pnpm package:collect

# 将已下载的同版本 macOS CI 安装包导入 mac 目录（不触发远程构建/发布）
pnpm package:collect --platform mac --source "D:\Downloads\Mochi-mac"

# 应用图标：scripts/gen-icon.mjs 生成源图 → tauri icon 出全尺寸
node scripts/gen-icon.mjs
pnpm tauri icon src-tauri/icons/app-icon.png
```

收集脚本核对项目版本，只接纳本版正式安装文件，写入大小与 SHA-256 清单；打包过程与目录职责见 [项目结构](docs/project-structure.md)。

**发布（部署纪律）**：push tag `v*` 触发 GitHub Actions 双平台构建（Windows NSIS/MSI +
macOS universal .dmg，未签名），自动附到 GitHub Release（draft）。**发布必须由项目所有者
显式声明执行**（见 AGENTS.md），工作流定义见 `.github/workflows/release.yml`。

## 检查与安装更新

双击宠物打开聊天窗 →「设置」首屏的「版本与更新」→「检查更新」。只有点击时才读取公开正式 Release，不做后台检查；草稿和预发布版本不会推荐给用户。发现新版本后可查看说明，打开浏览器下载适合本机的安装包；未找到对应系统或芯片的包时，提供发布页入口供核对。

下载完成后先从托盘退出 Mochi，再覆盖安装到原位置；macOS 将新应用替换到 Applications。正常覆盖安装保留聊天、待办、设置与自定义素材。更新前可通过「设置 → 关于 → 打开数据目录」备份，更新后回到「版本与更新」核对版本号。下载与安装由用户完成，应用不会自动执行安装器或重启。

## 用户数据

运行数据全部在本机：`{应用数据目录}/com.mochi.pet/`（SQLite mochi.db + settings.json +
pet-assets/ 自定义素材）。卸载重装/升级均保留；"清空聊天历史"在设置页。

## 日常动作与提醒

- 按住宠物移动约 5px 开始拖动；双击打开聊天；单击会等待约 500ms 区分双击，再弹跳并重置站立计时；右键菜单操作不重置计时。
- 单击还会弹出一张约7秒的小纸条：144条早晚问候、专注陪伴、轻休息建议和摸摸玩笑，按时间/应用状态轮换，使用设置中的称呼；无Key也可用。文案规则见[单击小纸条](docs/pet-chatter.md)。
- 隐藏宠物或关闭聊天窗仍驻留托盘，提醒服务继续运行；真正退出应用后不执行提醒。
- 站立、番茄钟和定时提醒均显示包含正文的应用弹窗，同时到点会排队。系统通知开关只影响 OS 通知，不会关闭应用弹窗。
- 离开时站立/定时提醒推迟到恢复活动后展示；系统睡眠期间不能弹窗，恢复后补检查。
- 定时提醒未确认即退出时，重启会恢复；确认已落库的不重复展示。番茄钟和站立倒计时仍不跨退出恢复。

开发验证：`pnpm check`、`pnpm test`、`pnpm build`；安装包收集脚本验证为 `pnpm test:packaging`。`.github/workflows/check.yml` 对日常 main 推送做 Windows/macOS 检查，独立于发布流程。

本地浏览器界面回归（使用 Tauri 官方 IPC mocks，验证前端，不代替原生窗口验收）：

```powershell
pnpm dev
# 在另一个终端运行；首次会安装 Playwright CLI，需本机 Chrome
npx --yes --package @playwright/cli playwright-cli open http://localhost:1420 --browser chrome
npx --yes --package @playwright/cli playwright-cli run-code --filename scripts/ui-smoke.cjs
# 版本更新流程（模拟公开版本和原生 IPC，不真实下载安装）
npx --yes --package @playwright/cli playwright-cli run-code --filename scripts/update-smoke.cjs
npx --yes --package @playwright/cli playwright-cli close
```

## 文档导航

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 项目工作流规范（提交纪律、部署纪律、代码规范）——**协作前必读** |
| [run_here/README.md](run_here/README.md) | Windows/macOS 安装包入口、生成命令与覆盖升级步骤 |
| [docs/project-structure.md](docs/project-structure.md) | 源码、原生宿主、脚本、文档与安装包路径职责 |
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
