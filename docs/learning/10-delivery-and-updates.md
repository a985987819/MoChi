# 10 · 安装包交付与版本更新

> 对应版本：v0.9.0 体验打磨追加。前置：[06 Tauri](06-tauri-for-frontend.md)、[07 应用边界](07-agent-vs-app-boundary.md)。
> 学完标准：从构建产物独立写出安装包收集器，并实现不会误降级、可取消、可重试的公开版本检查。

## 1. 目标

让使用者在根目录 `run_here/windows/`、`run_here/mac/` 找到安装器，让开发者用 `pnpm package` 完成当前平台构建与收集。应用内「设置 → 版本与更新」检查公开正式版本，显示说明、打开安装包下载，并说明怎样覆盖安装保留本机数据。

版本比较、文件选择和网络状态都属于确定性应用能力，放在 `src/services/app-updates.ts`；不调用模型、不读取 API Key，也不注册 Agent 工具。

## 2. 核心概念

- **构建缓存**：`src-tauri/target/` 中的编译中间文件和原生程序，不适合作为用户寻找安装器的入口。
- **安装器**：Windows 的 `*-setup.exe`、`.msi`，macOS 的 `.dmg`。独立的 `mochi.exe` 和源码压缩包都不是本流程认可的安装器。
- **交付目录**：`run_here/{windows,mac}/` 只收集当前项目版本的安装器，并用 `manifest.json` 记录版本、字节数、SHA-256；二进制及清单被 Git 忽略，目录说明被跟踪。
- **发布状态**：打出安装包、创建草稿 Release、公开 Release 是三件不同的事。匿名更新检查只能看到公开正式版。
- **更新状态**：`available` 有新版、`current` 无需更新（包括本地版本更高）、`unpublished` 无公开正式版、`error` 可重试失败、`cancelled` 请求已取消。

## 3. 业界规范与常见做法

安装包文件名和应用内版本必须一致。比较版本使用 SemVer：先比较主/次/补丁版本，再比较预发布标识，忽略 `+build` 元数据。字符串比较会错误得出 `"0.10.0" < "0.9.0"`；把三个数字拼成小数同样错误。

原生自动更新通常还需要独立的更新签名、发布密钥与更新清单。本次按用户选择提供「检查 → 查看说明 → 浏览器下载 → 手动覆盖安装」，保留系统安装器的确认环节。

网络失败不能报成「已经最新」；打开系统浏览器不能报成「已经下载」；校验 SHA-256 能证明文件复制一致，不能代替代码签名或证明发布者身份。

## 4. 本项目实现走读

### 4.1 从构建到安装目录

`scripts/package-app.mjs` 先读取 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。版本不一致立即停止，避免把旧应用装进新文件名。Windows 经 `scripts/vsenv.cmd` 加载 MSVC 后调用 `pnpm tauri build`；macOS 直接调用。构建失败不会进入收集阶段。

`scripts/collect-installers.mjs` 的流程可以还原为：

```text
验证三个配置的版本一致
定位 target[/指定target]/release/bundle 或 --source
找产品名_精确版本_开头、且扩展名符合平台的真实文件
拒绝空文件、同名不同内容、符号链接入口
计算大小与 SHA-256
复制到 run_here/平台/.staging-随机ID 并再次校验
逐个备份旧目标，再提升新安装文件，最后替换 manifest
提升失败时逆序恢复；恢复也失败则保留备份并给恢复路径
仅移除旧 manifest 声明的本产品旧包
清理临时目录
```

不递归清空 `run_here`：用户可能自行放入其他文件；上一次收集清单是旧安装器清理的依据。同版本重复打包也必须支持替换原文件和清单。

Windows 中安装器可能被其他进程锁定。只有暂存目录还不够：若先替换 MSI，随后 EXE 替换失败，旧 manifest 会与新 MSI 不符。因此提升阶段记录每个文件的旧备份和安装状态，任一步失败即逆序回滚。回滚本身也可能被文件锁阻止，此时保留恢复目录并报告路径，不能在 `finally` 删除仅存的旧备份。这是处理操作失败的回滚机制，不承诺断电时的多文件原子性。

`bundleDirectory()` 同时处理默认 `target` 与 `CARGO_TARGET_DIR`。Apple 通用包另有一层 `universal-apple-darwin`，因此显式 target 必须同时传给构建与收集。

收集器测试用 Node 内置测试运行器执行真实临时文件操作，通过 `pnpm test:packaging` 接入既有 Windows/macOS 检查工作流。Windows 文件锁用独立进程持有共享只读句柄真实复现；其他系统跳过这一特定用例。

### 4.2 Windows 编译环境

`vsenv.cmd` 用 Visual Studio 自带 `vswhere.exe` 查找已安装的 C++ 工具链，不再写死 VS 年份/版本；原 2022 BuildTools 路径保留为兼容回退。`setlocal` 限制环境变量只影响本次命令；可选的 `scripts/vsenv.local.cmd` 被 Git 精确忽略，仅记录本机 Rust 路径，使用 `if not defined` 保留外部配置。未配置 `CARGO_HOME` 时回退到用户默认 Cargo 路径。

批处理末尾必须用 `call %*` 执行目标并传回退出码。`pnpm` 在 Windows 上通常是另一个 `.cmd`；没有 `call` 就会转移批处理控制权，外层 `setlocal` 的局部环境可能提前结束，出现「直接 cargo 可用，经 pnpm 却找不到 cargo」。普通 `.exe` 探针不能覆盖这个差异，因此还要验证 `vsenv → pnpm → Node/Cargo` 的完整子进程链。

本次 Rust 源码、Cargo 依赖和 Tauri capability 均不需要新增修改。原生运行和权限仍复用已有实现。

### 4.3 公开版本检查

`checkForAppUpdate(options)` 只请求项目固定仓库的 `/releases/latest`，不带凭据、不带用户设置。`response.json()` 的返回值先作为 `unknown`，验证对象、版本、draft/prerelease 和 assets 后才使用。

SemVer 解析保留数字字符串，通过长度和字典顺序比较，避免超出 JavaScript 安全整数范围后误判。本地 `0.9.0` 对公开 `0.8.2` 返回 `current` 且 `relation: "ahead"`，不会引导降级。404 返回 `unpublished`；403/429、断网、格式错误、超时分别给出可操作提示。

安装包选择按系统进行：Windows 优先匹配 x64 NSIS，回退 MSI；macOS 优先 universal DMG，只有明确架构时才选单架构 DMG。未知 Mac 架构且没有 universal 时不猜测，返回发布页。下载链接只接纳固定仓库、同一 tag、同一文件名的 HTTPS GitHub Release URL。

网络请求与读取 JSON 响应体共享超时边界。外部 `AbortSignal` 取消时返回 `cancelled`，`finally` 清理定时器和监听；`Promise.race` 保证不遵守取消信号的测试适配器也不会让界面一直等待。

### 4.4 组件生命周期与真实反馈

`src/pages/chat/AppUpdatesSection.tsx` 独立承担更新交互，由 `SettingsTab` 在首屏引入；专用 CSS 放同目录。用户点击时才检查，按钮在进行中禁用；切走设置页时取消请求。结果携带说明和可选安装器，UI 不再自行解析远端 JSON。

说明按可滚动纯文本显示，避免远端 HTML 影响 WebView。`openUrl` 成功后只提示浏览器已打开；失败展示可复制地址。覆盖安装步骤明确要求从托盘退出，并提供数据目录备份提示。这里不会启动安装器、重启应用或清除任何数据。

## 5. 设计取舍

| 选择 | 原因 | 代价 |
|---|---|---|
| 保留 Tauri 原始产物，额外收集到 run_here | 开发工具路径稳定，使用者入口简单 | 需要一份安装器复制空间 |
| 二进制忽略，说明入库 | 避免 Git 历史被大文件堆积；克隆后仍有清楚入口 | 新克隆仓库须构建或导入安装包 |
| 安装包只接纳当前版本 | 防止混装旧包和错误系统 | Mac 必须单独构建或导入同版产物 |
| 手动检查、浏览器下载 | 用户已明确选择；没有静默网络与自动安装 | 新版本需要用户主动检查并确认安装 |
| 不新增 Rust 更新插件 | 当前流程复用 app API 与 opener 即可 | 自动更新签名链路留到后续单独规划 |

## 6. 复盘自测（合上文档默写）

1. 画出「源码 → dist → Tauri bundle → run_here → 用户数据」五者的关系，指出哪些不能互相代替。
2. 为什么编译失败、目录没有当前版安装器时，不能删除已有安装器？
3. 写出包筛选、暂存复制、哈希比对、清单替换、受限旧包清理的伪代码。
4. 用 `0.9.0`、`0.10.0`、`0.10.0-rc.2`、`0.10.0-rc.10` 验证 SemVer 比较。
5. 分别处理公开接口 404、403、网络超时、本地版本更高和没有适合本机安装包五种情况。
6. 为什么取消逻辑需要覆盖响应体读取，而不只是 `fetch()` 返回响应之前？
7. `openUrl()` resolve 后可以宣称更新完成吗？用户需要看到什么反馈？
8. 自动下载安装重启需要补齐哪些发布与签名设施？为什么本次不需要更新私钥？

## 7. 延伸阅读

- [GitHub Releases REST API：最新正式版本](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)（2026-11-06 核验）。
- [SemVer 2.0.0](https://semver.org/)。
- [项目目录说明](../project-structure.md)、[安装目录说明](../../run_here/README.md)。
- 源码对照：`scripts/package-app.mjs`、`scripts/collect-installers.mjs`、`src/services/app-updates.ts`、`src/pages/chat/AppUpdatesSection.tsx`。
