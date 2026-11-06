# 项目结构与路径入口

## 先选入口

| 目的 | 入口 |
|---|---|
| 直接安装并使用桌宠 | `run_here/windows/` 或 `run_here/mac/`，操作见 [安装说明](../run_here/README.md) |
| 修改代码并启动开发环境 | 根目录 `package.json`，Windows 执行 `scripts\vsenv.cmd pnpm tauri dev` |
| 构建并整理本机安装包 | 根目录执行 `pnpm package` |
| 只整理已有安装包 | `pnpm package:collect`；导入其他平台已下载的包时指定 `--platform` 与 `--source` |
| 检查版本并手动升级 | 应用「设置 → 版本与更新」；只在点击时检查公开正式 Release |
| 查询开发进度与验收状态 | [roadmap.md](roadmap.md)；其他文档不能替代该文件的进度记录 |

安装包需要在对应系统构建。目录已创建不等于两个系统均已有安装包；刚克隆仓库时仅有说明文件。

## 根目录职责

```text
MoChi/
├─ src/                         TypeScript / React 源码
│  ├─ pages/                    pet、chat、alert 三个窗口页面
│  ├─ shared/                   跨窗口事件、共享文案与组件
│  ├─ services/                 应用执行、存储与生命周期服务
│  ├─ agent/                    Agent 循环、提供商、工具、记忆编排
│  ├─ rag/                      BM25、分词、索引、检索与内置食品数据
│  └─ assets/pet/               内置宠物素材
├─ src-tauri/                   Tauri 原生宿主、权限、配置与图标
│  ├─ src/                     原生窗口、托盘、系统事件等最小能力
│  ├─ capabilities/            前端可调用的原生能力声明
│  ├─ windows/                 Windows 安装器钩子
│  ├─ icons/                   应用图标，源图 app-icon.png 也在这里
│  └─ target/                  Rust 缓存、原生可执行文件与原始打包结果（生成）
├─ scripts/                     构建环境、打包收集、图标与界面验证脚本
├─ docs/                        路线图、版本实施记录与教学文档
├─ run_here/                    面向使用者的安装文件入口
│  ├─ windows/                 当前收集的 Windows .exe / .msi 与 manifest.json
│  └─ mac/                     当前收集的 macOS .dmg 与 manifest.json
├─ dist/                        Vite 生成的前端静态资源（生成）
├─ index.html                   宠物窗口 HTML 入口
├─ chat.html                    聊天窗口 HTML 入口
├─ alert.html                   提醒窗口 HTML 入口
└─ package.json / vite.config.ts / tsconfig*.json
                                根级命令、前端多入口与类型配置
```

`dist/`、`src-tauri/target/` 和 `run_here/` 中的安装文件是不同阶段的产物：前端静态文件交给 Tauri，Tauri 在原生构建目录生成安装器，收集脚本再把安装器复制到 `run_here/`。修改源码后需重新打包才会更新可安装文件。上述生成物不提交 Git，目录说明与构建脚本提交 Git。

`CARGO_TARGET_DIR` 可将 Rust 构建目录放到其他磁盘；收集脚本会读取该变量。没有配置时使用上图的 `src-tauri/target/`。

## 为什么保留根目录的三个 HTML

Mochi 有 pet、chat、alert 三个独立 Tauri WebView。`vite.config.ts` 的 `rollupOptions.input` 显式构建三个 HTML；`src-tauri/tauri.conf.json` 的窗口 URL 分别加载 `index.html`、`chat.html`、`alert.html`。

三个文件各自引用 `src/pages/<窗口>/main.tsx`。HTML 放在 Vite 根目录能让开发 URL 与安装后资源路径一致。这里保留根入口，把页面实现集中在 `src/pages/`；修改页面通常只需进入对应窗口目录。

## TypeScript 代码怎么找

| 目录 | 负责什么 | 典型修改入口 |
|---|---|---|
| `src/pages/pet/` | 宠物显示、手势、菜单、气泡 | `PetApp.tsx`、`gestures.ts` |
| `src/pages/chat/` | 对话、设置、待办、番茄钟界面 | `ChatApp.tsx`、`SettingsTab.tsx`、`AppUpdatesSection.tsx` |
| `src/pages/alert/` | 提醒弹窗与确认交互 | `AlertApp.tsx` |
| `src/shared/` | 跨窗口契约、共享组件与确定性文案处理 | `events.ts`、`components/` |
| `src/agent/core/` | Agent 循环、上下文组装、历史窗口裁剪 | `agent.ts`、`context-builder.ts` |
| `src/agent/providers/` | LLM 协议、SSE、提供商预设 | `openai-compatible.ts`、`sse.ts` |
| `src/agent/tools/` | 把应用能力包装为模型可调用的工具 | `registry.ts` 及各工具文件 |
| `src/agent/memory/` | 会话历史与长期记忆的读取、检索和上下文编排 | `history-store.ts`、`long-term.ts` |
| `src/services/` | 设置/数据库、待办、提醒、计时、宠物状态、更新检查等应用能力 | 对应服务文件及 `__tests__/` |
| `src/rag/` | 不依赖模型的确定性检索、分词、BM25 与食品数据 | `bm25.ts`、`indexer.ts`、`food.ts`、`data/food/` |

Agent 负责理解意图和选择工具；Service 负责实际执行与存储。按钮与 Agent 工具应调用同一套应用能力，防止计时、待办等状态出现两套来源。更新检查是确定性的应用能力，放在 `src/services/app-updates.ts`；它不需要 API Key，也不经过 Agent。RAG 的算法与数据放在 `src/rag/`，供工具和记忆流程复用。新功能归属以 [07-agent-vs-app-boundary.md](learning/07-agent-vs-app-boundary.md) 为准。

TypeScript 的 `@/` 对应 `src/`，由 Vite 与 TypeScript 配置共同声明。模块内的小范围引用可保持相对路径；跨职责目录时可使用 `@/services/...` 等路径看清归属。

## 打包脚本与安装目录

- `scripts/vsenv.cmd`：Windows 统一 MSVC 入口，通过 `vswhere` 查找已安装的 C++ 工具链，尊重自定义 `CARGO_HOME`；可先加载本机专用的 `scripts/vsenv.local.cmd`。
- `scripts/package-app.mjs`：检查版本一致性，在本机执行 Tauri 构建，成功后调用安装包收集逻辑。
- `scripts/collect-installers.mjs`：从构建目录或 `--source` 收集本产品当前版本的 `.exe`、`.msi`、`.dmg`，写入各平台的 `manifest.json`，记录版本、字节大小和 SHA-256。
- `scripts/gen-icon.mjs`：生成 `src-tauri/icons/app-icon.png`，可继续交给 `pnpm tauri icon` 生成各尺寸图标。
- `scripts/ui-smoke.cjs`、`scripts/update-smoke.cjs`：宠物/提醒与更新流程的浏览器回归；脚本测试见 `scripts/tests/`，应用测试位于 `src/**/__tests__/`。

安装器与清单不会写入用户数据。聊天、待办、设置和自定义素材仍在操作系统应用数据目录下的 `com.mochi.pet/`；从托盘退出后覆盖安装到原位置，正常情况下会继续使用这些数据。更新前可在「设置 → 关于」打开数据目录备份。

### 本机 Windows 工具路径

Rust 安装到自定义磁盘时，可创建可选文件 `scripts/vsenv.local.cmd`。该文件被精确加入 Git 忽略规则，只记录本机路径，不提交仓库；例如：

```bat
@echo off
if not defined CARGO_HOME set "CARGO_HOME=E:\tools\mochi-rust\cargo"
if not defined RUSTUP_HOME set "RUSTUP_HOME=E:\tools\mochi-rust\rustup"
exit /b 0
```

路径应改为本机真实安装位置。`if not defined` 保留终端或 CI 已传入的环境变量；外层 `vsenv.cmd` 使用 `setlocal`，执行完成后不改变父终端的全局环境。包装脚本会检查本机配置的退出码，失败时停止构建，避免带着半套环境继续运行。无需本机配置时可省略该文件，使用已安装到默认位置或终端已配置的 Rust 工具链。

配置完成后可执行 `scripts\vsenv.cmd cargo --version` 验证；`pnpm package` 会经过同一包装，无需每次手工设置环境变量。

## 文档怎么找

`docs/roadmap.md` 管进度；`docs/versions/` 记录每版实现与验证；`docs/learning/` 解释设计及代码走读；`docs/iterations/` 保存施工计划。宠物素材规则查 `docs/pet-assets.md`，单击文案规则查 `docs/pet-chatter.md`。安装与升级操作集中在 `run_here/README.md`，本文件负责路径导航。
