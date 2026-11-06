# 从这里安装 Mochi

这里与 `src/` 平级，专门放**打包好的安装文件**；源码在 `src/`，Rust 构建缓存仍在 `src-tauri/target/`。

| 目录 | 安装文件 | 操作 |
|---|---|---|
| `windows/` | `Mochi_版本_x64-setup.exe`（推荐）或 `.msi` | 任选一种安装，升级时直接覆盖安装 |
| `mac/` | `Mochi_版本_架构.dmg` | 打开后拖入 Applications，选择替换旧版 |

安装文件由本机或对应平台 CI 构建生成，不提交 Git；刚克隆仓库时只有说明，没有可安装文件。
`manifest.json` 在生成后记录本目录安装器的**版本、字节大小、SHA-256**，用于区分旧包和校验复制结果。
两个平台可能尚未同时构建，请以各自 manifest 的版本为准。

## 生成本机安装包

```powershell
pnpm package
```

Windows 自动经 `scripts\vsenv.cmd` 加载 MSVC 环境，产出 `.exe`、`.msi`；需预先安装 Rust、VS Build Tools 与 Windows SDK。
工具链位于自定义磁盘时，可在不提交 Git 的 `scripts/vsenv.local.cmd` 中记录本机 Rust 路径，见 [项目结构说明](../docs/project-structure.md#本机-windows-工具路径)。
macOS 生成本机架构 `.dmg`；如需 Intel 和 Apple Silicon 通用包，在 Mac 上先安装两个 Rust target，再执行：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm package --target universal-apple-darwin
```

**Windows 无法生成 macOS 安装包。** 在 Mac 上构建，或将已下载的对应版本 CI 安装文件导入：

```powershell
pnpm package:collect --platform mac --source "D:\Downloads\Mochi-mac"
```

已有 Tauri 本机构建产物时，可执行 `pnpm package:collect`；自定义 target 的产物需补 `--target universal-apple-darwin`。
收集脚本只接纳与当前项目版本匹配的安装文件；不会联网，也不会发布 Release。

## 升级前后

1. 在应用「设置 → 版本与更新」查看新版本说明并下载对应系统安装包。
2. 从托盘退出 Mochi，运行新安装器；macOS 将新应用替换到原位置。
3. 保留原安装路径与用户数据目录，重新打开。聊天、待办、设置与自定义宠物素材继续使用。

用户数据在应用数据目录 `com.mochi.pet/`，与本目录分离。macOS 未签名包的首次打开说明见根目录 README。
