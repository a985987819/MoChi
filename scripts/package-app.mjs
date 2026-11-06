/**
 * 一个命令完成“本机编译 → 安装包归档”。
 * Windows 保留项目必需的 MSVC 包装脚本；macOS 默认只构建本机架构，
 * 需要同时支持 Intel/Apple Silicon 时传 --target universal-apple-darwin。
 */
import { spawnSync } from "node:child_process";
import { bundleDirectory, collectInstallers, parseArguments, platformDirectory, projectRoot, readPackageMetadata } from "./collect-installers.mjs";

try {
  const options = parseArguments(process.argv.slice(2), ["target"]);
  const platform = platformDirectory();
  const metadata = await readPackageMetadata();
  // Windows cmd.exe 会再次解释文本，因此 target 必须是合法 Rust target 字符。
  if (options.target && !/^[A-Za-z0-9_-]+$/.test(options.target)) throw new Error("--target 只能包含字母、数字、下划线或短横线。");
  const args = ["tauri", "build", ...(options.target ? ["--target", options.target] : [])];
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `scripts\\vsenv.cmd pnpm ${args.join(" ")}`], { cwd: projectRoot, stdio: "inherit" })
    : spawnSync("pnpm", args, { cwd: projectRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Tauri 构建失败（退出码 ${result.status ?? "未知"}），既有安装包保持不变。`);
  const manifest = await collectInstallers({ ...metadata, platform, source: bundleDirectory(options.target) });
  console.log(`[package] 构建完成：run_here/${manifest.platform}/，v${manifest.version}，${manifest.files.length} 个安装包。`);
} catch (error) {
  console.error(`[package] ${error.message}`);
  process.exitCode = 1;
}
