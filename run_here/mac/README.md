# macOS 安装包

在 Mac 的项目根目录执行 `pnpm package`，或构建通用包：

```bash
pnpm package --target universal-apple-darwin
```

打开 `Mochi_版本_架构.dmg`，将 Mochi 拖入 Applications；升级时先退出应用，再替换旧版。
本机架构包须与 Mac 芯片匹配，`universal` 同时支持 Intel 和 Apple Silicon。
未签名包首次打开说明见项目根目录 README。

Windows 无法本地生成本目录的安装包。可在 Windows 导入已下载的同版本 macOS CI 产物：

```powershell
pnpm package:collect --platform mac --source "D:\Downloads\Mochi-mac"
```

若当前仅有本说明，表示尚未成功构建/导入 macOS 安装包；不会把说明文件当作安装包。
