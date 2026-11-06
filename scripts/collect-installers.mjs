/**
 * 将 Tauri 的深层构建目录整理为用户能直接找到的安装目录。
 * 只认产品名 + 当前版本 + 平台后缀，防止把旧包或未打包的 mochi.exe 当成新安装器。
 * 二进制不进 Git；每个平台的 manifest.json 记录可校验的版本、大小与 SHA-256。
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 配置不一致时提前终止，避免文件名版本与应用内版本互相矛盾。 */
export async function readPackageMetadata(root = projectRoot) {
  const [packageJson, tauriJson, cargoToml] = await Promise.all([
    readFile(join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(join(root, "src-tauri/tauri.conf.json"), "utf8").then(JSON.parse),
    readFile(join(root, "src-tauri/Cargo.toml"), "utf8"),
  ]);
  const cargoVersion = cargoToml.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  const version = packageJson.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("package.json 缺少有效版本号。");
  }
  if (version !== tauriJson.version || version !== cargoVersion) {
    throw new Error("package.json、tauri.conf.json 与 Cargo.toml 的版本不一致，请先同步版本。");
  }
  if (typeof tauriJson.productName !== "string" || !/^[A-Za-z0-9_-]+$/.test(tauriJson.productName)) {
    throw new Error("安装包收集需要不含路径字符的 productName。");
  }
  return { version, productName: tauriJson.productName };
}

/** 已知平台才映射目录；不将 Linux 产物混放进 Windows/macOS。 */
export function platformDirectory(platform = process.platform) {
  if (platform === "win32" || platform === "windows") return "windows";
  if (platform === "darwin" || platform === "mac") return "mac";
  throw new Error(`暂不支持平台 ${platform}，请指定 --platform windows 或 --platform mac。`);
}

function isInstaller(name, platform) {
  return platform === "windows" ? /(?:-setup\.exe|\.msi)$/i.test(name) : /\.dmg$/i.test(name);
}

/** 不遍历符号链接：收集目录应是实际产物，不能隐式读入目录外文件。 */
async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/**
 * 先完整校验并暂存，再以可回滚步骤替换安装器与清单；找不到本版包时保留既有文件。
 * 仅清理上次 manifest 明确记录、且仍匹配本产品的旧安装器，保留用户自行放入的文件。
 */
export async function collectInstallers({ source, platform, version, productName = "Mochi", root = projectRoot }) {
  const platformName = platformDirectory(platform);
  const sourceDirectory = resolve(source);
  let sourceInfo;
  try {
    sourceInfo = await lstat(sourceDirectory);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`安装包来源不存在：${sourceDirectory}。请先构建，或用 --source 指定已下载的安装包目录。`);
    throw error;
  }
  if (sourceInfo.isSymbolicLink()) throw new Error("安装包来源不能是符号链接。");
  if (!sourceInfo.isDirectory()) throw new Error("--source 必须指定安装包所在目录。");
  const prefix = `${productName}_${version}_`;
  const candidates = (await listFiles(sourceDirectory))
    .filter(file => basename(file).startsWith(prefix) && isInstaller(basename(file), platformName))
    .sort();
  if (candidates.length === 0) {
    throw new Error(`未找到 ${productName} ${version} 的 ${platformName} 安装包：${sourceDirectory}。请先完成该平台构建。`);
  }

  const selected = new Map();
  for (const file of candidates) {
    const name = basename(file);
    const size = (await stat(file)).size;
    if (size === 0) throw new Error(`安装包为空：${file}`);
    const sha256 = await digest(file);
    const prior = selected.get(name);
    if (prior && prior.sha256 !== sha256) throw new Error(`存在同名但内容不同的安装包：${name}。请指定更精确的 --source。`);
    selected.set(name, { source: file, name, size, sha256 });
  }

  const installerRoot = join(root, "run_here");
  await mkdir(installerRoot, { recursive: true });
  if ((await lstat(installerRoot)).isSymbolicLink()) throw new Error("run_here 不能是符号链接。");
  const destination = join(installerRoot, platformName);
  await mkdir(destination, { recursive: true });
  if ((await lstat(destination)).isSymbolicLink()) throw new Error("安装包目标目录不能是符号链接。");
  const manifestPath = join(destination, "manifest.json");
  let previousFiles = [];
  try {
    const previous = JSON.parse(await readFile(manifestPath, "utf8"));
    if (Array.isArray(previous.files)) previousFiles = previous.files;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("现有 manifest.json 无法读取，请检查后再收集。", { cause: error });
  }

  const staging = join(destination, `.staging-${randomUUID()}`);
  await mkdir(staging);
  const manifest = {
    productName, version, platform: platformName, generatedAt: new Date().toISOString(),
    files: [...selected.values()].map(({ name, size, sha256 }) => ({ name, size, sha256 })),
  };
  let preserveStaging = false;
  try {
    for (const file of selected.values()) {
      const temporaryFile = join(staging, file.name);
      await copyFile(file.source, temporaryFile);
      if (await digest(temporaryFile) !== file.sha256) throw new Error(`安装包复制校验失败：${file.name}`);
    }
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    // rename 只能保证单文件原子性，不能保证“一组安装器 + manifest”同时替换。
    // Windows 的文件占用可能让第二次 rename 失败，因此每一步都保留可逆状态：
    // ① 旧目标移入备份；② 新文件移到目标；③ 全部成功后才视为提交完成。
    const backupDirectory = join(staging, "backup");
    await mkdir(backupDirectory);
    const operations = [];
    try {
      for (const name of [...manifest.files.map(file => file.name), "manifest.json"]) {
        const operation = { name, backedUp: false, installed: false };
        operations.push(operation);
        let existing;
        try {
          existing = await lstat(join(destination, name));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (existing) {
          if (!existing.isFile()) throw new Error(`目标不是普通文件，停止替换：${name}`);
          await rename(join(destination, name), join(backupDirectory, name));
          operation.backedUp = true;
        }
        await rename(join(staging, name), join(destination, name));
        operation.installed = true;
      }
    } catch (error) {
      const recoveryErrors = [];
      // 逆序撤销：先恢复最后改变的文件，再恢复之前的文件，清单也走相同协议。
      // 有旧文件时直接用备份 rename 覆盖；无旧文件时只删除本次新建的目标。
      for (const operation of operations.reverse()) {
        try {
          if (operation.backedUp) {
            await rename(join(backupDirectory, operation.name), join(destination, operation.name));
          } else if (operation.installed) {
            await rm(join(destination, operation.name), { force: true });
          }
        } catch (recoveryError) {
          recoveryErrors.push(new Error(`恢复 ${operation.name} 失败`, { cause: recoveryError }));
        }
      }
      if (recoveryErrors.length > 0) {
        // 备份可能已是旧安装器的唯一副本；不能在 finally 中把恢复线索一并删除。
        preserveStaging = true;
        throw new Error(`安装包替换失败，部分文件未能自动恢复。请关闭安装器或占用文件的程序，再将 ${backupDirectory} 中的文件移回 ${destination}，覆盖同名文件后重试。恢复备份已保留。`,
          { cause: new AggregateError([error, ...recoveryErrors]) });
      }
      throw new Error("安装包替换失败，已恢复原安装包和清单。请关闭安装器或占用文件的程序后重试。", { cause: error });
    }

    // 到这里新安装器与新清单已全部提交；清旧版本只发生在提交成功之后。
    for (const previous of previousFiles) {
      const name = previous?.name;
      if (typeof name === "string" && basename(name) === name && name.startsWith(`${productName}_`)
        && isInstaller(name, platformName) && !selected.has(name)) {
        await rm(join(destination, name), { force: true });
      }
    }
  } finally {
    if (!preserveStaging) await rm(staging, { recursive: true, force: true });
  }
  return manifest;
}

/** 参数只解析值，绝不拼成 shell 命令；--source 用于导入已下载的 CI 安装包目录。 */
export function parseArguments(args, allowed = ["source", "platform", "target"]) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index].replace(/^--/, "");
    if (!args[index].startsWith("--") || !allowed.includes(name) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(`无效参数：${args[index]}。可用参数：${allowed.map(key => `--${key} <值>`).join("、")}`);
    }
    options[name] = args[++index];
  }
  return options;
}

export function bundleDirectory(target, root = projectRoot) {
  const targetDirectory = process.env.CARGO_TARGET_DIR
    ? resolve(root, "src-tauri", process.env.CARGO_TARGET_DIR)
    : join(root, "src-tauri", "target");
  return target ? join(targetDirectory, target, "release", "bundle") : join(targetDirectory, "release", "bundle");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const metadata = await readPackageMetadata();
    const manifest = await collectInstallers({ ...metadata, platform: options.platform ?? process.platform,
      source: options.source ?? bundleDirectory(options.target) });
    console.log(`[package] ${manifest.files.length} 个安装包已整理到 run_here/${manifest.platform}/（v${manifest.version}）。`);
  } catch (error) {
    console.error(`[package] ${error.message}`);
    process.exitCode = 1;
  }
}
