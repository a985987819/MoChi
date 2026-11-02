# Mochi（麻薯）项目规范

> 本文件是项目级约束，任何 AI 助手 / 协作者在本仓库工作前必须先阅读并遵守。
> 与个人习惯冲突时，以本文件为准。

## 项目一句话

跨 Windows / macOS 的 AI 桌宠：图片命名约定驱动宠物状态切换；接入 DeepSeek（可扩展多提供商）实现对话、待办、站立提醒、番茄钟、快餐热量查询（RAG）。Tauri 2 + React 18 + TypeScript，Agent 逻辑全部在 TS 前端层。

## 工作流铁律

### 1. 每次对话结束必须「总结 + 提交」

- 每次会话（对话）结束前：
  1. 更新/创建对应版本的 `docs/versions/vX.Y.Z-*.md` 实施记录（做了什么、关键实现、踩坑、自测结果）；
  2. 向用户输出本次会话总结（完成项 / 未完成项 / 下一步）；
  3. `git add` + `git commit`，不留未提交的工作区改动（node_modules 等忽略项除外）。
- Commit message 使用 Conventional Commits，并标注版本：
  - `feat(v0.2.0): 宠物状态管理器与素材回退链`
  - `fix(v0.3.0): 修复 SSE 流解析丢帧`
  - `docs(v0.2.0): 补充素材命名约定文档`
- 一个会话至少一个 commit；同一个版本多次会话则追加多个 commit。

### 2. 部署动作必须显式声明

以下动作属于「部署」，**仅在用户当次对话中明确要求时才执行**，不得自行操作：

- `git push`（任何远程推送）
- `git tag` 与 Release 发布
- 构建对外分发的安装包并交付（本地 `pnpm tauri build` 做验证除外，但产物不外发）
- 修改 CI 发布配置触发的发布流程

### 3. 版本与分支

- 主分支 `main`，日常开发直接提交到 `main`（单人项目，简化流程）。
- 版本号遵循 `v0.Y.0` 里程碑制，对应关系见 `docs/roadmap.md`。
- 每完成一个版本的全部验收标准，才允许开下一个版本（学习项目，宁慢勿漏）。

## 代码规范

- **TypeScript strict 模式**；禁止 `any`（确需时用 `unknown` + 类型收窄，并注释原因）。
- **目录职责**（`src/` 下）：
  - `agent/` —— Agent 内核：core（循环）、providers（提供商）、tools（工具）、memory（记忆）、rag（检索）。**不得**在其中 import React 组件；通过事件/回调与 UI 解耦。
  - `components/` —— React UI 组件。
  - `services/` —— 计时器、窗口管理等应用服务。
  - `assets/pet/` —— 打包内置宠物素材。
- **功能归属裁决**：新功能/新工具设计前必查 `docs/learning/07-agent-vs-app-boundary.md`——意图层可归 Agent，执行层走应用 Service（工具只是薄封装），存储层 100% 应用；新工具上线前过该文档 §6.3 自查表。
- **注释密度：教学型**。核心模块（agent、rag、memory）的每个导出函数/类必须有 JSDoc，解释「为什么这样设计」而不仅是「做了什么」；关键算法（BM25、Agent 循环、上下文组装）在实现处有分步注释。这是学习项目，注释是文档的一部分。
- Rust 侧（`src-tauri/`）只保留 Tauri 必需的最小配置与命令；每处修改在对应版本文档里逐行解释（用户是前端工程师）。
- 环境变量与密钥：API Key 只存 `tauri-plugin-store`（应用数据目录），**严禁**硬编码、提交到仓库或写入日志。

## 文档规范

- `docs/roadmap.md`：版本路线与每版验收标准，是唯一的进度事实源；每版完成后勾选更新。
- `docs/versions/vX.Y.Z-*.md`：每版一份实施记录，结构固定：目标 / 功能清单 / 文件级实现细节 / 新增依赖 / 设计取舍 / 踩坑与解决 / 自测清单（含执行结果）。
- `docs/learning/`：Agent 开发学习文档，统一结构：目标 → 核心概念 → 业界规范与常见做法 → 本项目实现走读（关键代码逐段讲解）→ 设计取舍 → 复盘自测（默写伪代码清单）→ 延伸阅读。标准是**只看文档能复盘并独立重写出对应代码**。
- `docs/pet-assets.md`：宠物素材命名约定（用户放置自定义素材的唯一依据，改动需同步 v0.2.0 文档）。
- 文档与代码不一致时，视为 bug：先改文档或在同次提交中同步两者。

## 环境备忘（Windows）

- Node 22 + pnpm（npm 全局装于 `F:\NodeJS\node_global`，已加入用户 PATH）；Rust stable-msvc（rustup）+ VS Build Tools（MSVC 14.44）+ Windows SDK 26100。
- **构建统一走包装脚本**（本机 rustc 不自动探测 MSVC，且 Git Bash 的 coreutils link.exe 会遮蔽）：
  `scripts\vsenv.cmd cargo check` / `scripts\vsenv.cmd pnpm tauri dev` / `scripts\vsenv.cmd pnpm tauri build`
- 常用命令：`pnpm check`（tsc --noEmit）/ `pnpm build`（前端构建）。
- macOS 构建依赖 GitHub Actions（见 `.github/workflows/build.yml`，v0.8.0 落地），本机无法产出 mac 包。
