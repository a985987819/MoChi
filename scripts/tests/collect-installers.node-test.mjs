/** 文件系统集成测试：校验收集边界与旧包替换，不运行或伪装真实安装器。 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { collectInstallers, parseArguments, readPackageMetadata } from "../collect-installers.mjs";

const temporaryRoots = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mochi-installer-test-"));
  temporaryRoots.push(root);
  const source = join(root, "bundle");
  await mkdir(source);
  return { root, source, platform: "windows", productName: "Mochi", version: "0.9.0" };
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("只收集本版本平台安装器，写入可核验清单", async () => {
  const options = await fixture();
  await mkdir(join(options.source, "nsis"));
  const bytes = Buffer.from("integration-test-fixture");
  await writeFile(join(options.source, "nsis", "Mochi_0.9.0_x64-setup.exe"), bytes);
  for (const name of ["Mochi_0.8.2_x64-setup.exe", "mochi.exe", "Mochi_0.9.0_universal.dmg", "Other_0.9.0_x64-setup.exe"]) {
    await writeFile(join(options.source, name), "ignored fixture");
  }
  const manifest = await collectInstallers(options);
  assert.equal(manifest.version, "0.9.0");
  assert.equal(manifest.files.length, 1);
  assert.deepEqual(manifest.files[0], { name: "Mochi_0.9.0_x64-setup.exe", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") });
  assert.deepEqual(JSON.parse(await readFile(join(options.root, "run_here/windows/manifest.json"), "utf8")), manifest);
});

test("没有本版包时失败，不损坏已有安装目录", async () => {
  const options = await fixture();
  const destination = join(options.root, "run_here/windows");
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "README.md"), "keep docs");
  await writeFile(join(destination, "Mochi_0.8.2_x64-setup.exe"), "old fixture");
  await writeFile(join(options.source, "Mochi_0.8.2_x64-setup.exe"), "old fixture");
  await assert.rejects(collectInstallers(options), /未找到 Mochi 0\.9\.0/);
  assert.deepEqual((await readdir(destination)).sort(), ["Mochi_0.8.2_x64-setup.exe", "README.md"]);
});

test("同名不同内容拒绝收集，避免目录遍历顺序决定最终安装包", async () => {
  const options = await fixture();
  await mkdir(join(options.source, "duplicate"));
  await writeFile(join(options.source, "Mochi_0.9.0_x64-setup.exe"), "first fixture");
  await writeFile(join(options.source, "duplicate", "Mochi_0.9.0_x64-setup.exe"), "different fixture");
  await assert.rejects(collectInstallers(options), /同名但内容不同/);
});

test("升级仅清理上次清单记录的本产品旧安装器", async () => {
  const options = await fixture();
  const destination = join(options.root, "run_here/windows");
  await mkdir(destination, { recursive: true });
  await writeFile(join(options.root, "outside.exe"), "keep outside");
  for (const name of ["Mochi_0.8.2_x64-setup.exe", "personal.txt", "README.md"]) await writeFile(join(destination, name), "keep unless old installer");
  await writeFile(join(destination, "manifest.json"), JSON.stringify({ files: [
    { name: "Mochi_0.8.2_x64-setup.exe" }, { name: "personal.txt" }, { name: "../../outside.exe" },
  ] }));
  await writeFile(join(options.source, "Mochi_0.9.0_x64_en-US.msi"), "new fixture");
  await collectInstallers(options);
  assert.deepEqual((await readdir(destination)).sort(), ["Mochi_0.9.0_x64_en-US.msi", "README.md", "manifest.json", "personal.txt"]);
  assert.equal(await readFile(join(options.root, "outside.exe"), "utf8"), "keep outside");
});

test("Mac 仅导入当前版本 dmg，不把 updater 压缩包当安装器", async () => {
  const options = { ...await fixture(), platform: "mac" };
  await writeFile(join(options.source, "Mochi_0.9.0_universal.dmg"), "disk image fixture");
  await writeFile(join(options.source, "Mochi_universal.app.tar.gz"), "updater fixture");
  const manifest = await collectInstallers(options);
  assert.equal(manifest.platform, "mac");
  assert.equal(manifest.files[0].name, "Mochi_0.9.0_universal.dmg");
  assert.equal(manifest.files.length, 1);
});

test("元数据不一致在构建前被拦截", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "src-tauri"));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.9.0" }));
  await writeFile(join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.8.2", productName: "Mochi" }));
  await writeFile(join(root, "src-tauri/Cargo.toml"), '[package]\nname = "mochi"\nversion = "0.9.0"\n');
  await assert.rejects(readPackageMetadata(root), /版本不一致/);
});

test("参数缺值或拼错明确失败", () => {
  assert.throws(() => parseArguments(["--source"]), /无效参数/);
  assert.throws(() => parseArguments(["--soruce", "folder"]), /无效参数/);
  assert.deepEqual(parseArguments(["--platform", "mac", "--source", "folder with spaces"]), { platform: "mac", source: "folder with spaces" });
});

test("来源缺失与空文件提供明确失败原因", async () => {
  const options = await fixture();
  await assert.rejects(collectInstallers({ ...options, source: join(options.root, "missing") }), /来源不存在/);
  await writeFile(join(options.source, "Mochi_0.9.0_x64-setup.exe"), "");
  await assert.rejects(collectInstallers(options), /安装包为空/);
});

test("Windows 重复收集可覆盖同名安装包和 manifest，也支持从目标目录重新校验", async () => {
  const options = await fixture();
  const name = "Mochi_0.9.0_x64-setup.exe";
  await writeFile(join(options.source, name), "first build fixture");
  const first = await collectInstallers(options);
  const destination = join(options.root, "run_here/windows");
  await writeFile(join(destination, "README.md"), "keep docs");

  // 同版本重新打包时文件名相同、内容可能不同；清单必须指向新的字节。
  await writeFile(join(options.source, name), "rebuilt fixture with different contents");
  const rebuilt = await collectInstallers(options);
  assert.notEqual(rebuilt.files[0].sha256, first.files[0].sha256);
  assert.equal(await readFile(join(destination, name), "utf8"), "rebuilt fixture with different contents");
  const repeated = await collectInstallers(options);
  assert.deepEqual(repeated.files, rebuilt.files);
  const revalidated = await collectInstallers({ ...options, source: destination });
  assert.deepEqual(revalidated.files, rebuilt.files);
  assert.deepEqual(JSON.parse(await readFile(join(destination, "manifest.json"), "utf8")).files, rebuilt.files);
  assert.deepEqual((await readdir(destination)).sort(), [name, "README.md", "manifest.json"]);
});

test("Windows 第二个安装包被占用时回滚第一个安装包，旧清单与文件仍匹配", {
  skip: process.platform !== "win32", timeout: 15000,
}, async () => {
  const options = await fixture();
  const msiName = "Mochi_0.9.0_x64_en-US.msi";
  const exeName = "Mochi_0.9.0_x64-setup.exe";
  // 使用真实 Tauri 目录结构，确保 msi 先提升、nsis/exe 后提升。
  await mkdir(join(options.source, "msi"));
  await mkdir(join(options.source, "nsis"));
  await writeFile(join(options.source, "msi", msiName), "old msi fixture");
  await writeFile(join(options.source, "nsis", exeName), "old exe fixture");
  const original = await collectInstallers(options);
  const destination = join(options.root, "run_here/windows");
  await writeFile(join(options.source, "msi", msiName), "new msi fixture");
  await writeFile(join(options.source, "nsis", exeName), "new exe fixture");

  // Node 的常规文件句柄允许删除共享，不能复现 Windows 安装器的排他锁。
  // 用独立 PowerShell 进程持有 FileShare.Read，收到换行后释放；不运行安装器。
  const worker = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-Command",
    "$lock = [System.IO.File]::Open($env:MOCHI_LOCK_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); try { [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $lock.Dispose() }",
  ], { env: { ...process.env, MOCHI_LOCK_FILE: join(destination, exeName) }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const workerExit = once(worker, "exit");
  try {
    await new Promise((resolveReady, rejectReady) => {
      let output = "";
      let errors = "";
      const timeout = setTimeout(() => { worker.kill(); rejectReady(new Error("等待 Windows 文件锁超时")); }, 5000);
      worker.stdout.on("data", chunk => {
        output += chunk.toString();
        if (output.includes("LOCKED")) { clearTimeout(timeout); resolveReady(); }
      });
      worker.stderr.on("data", chunk => { errors += chunk.toString(); });
      worker.once("error", error => { clearTimeout(timeout); rejectReady(error); });
      worker.once("exit", code => {
        clearTimeout(timeout);
        if (!output.includes("LOCKED")) rejectReady(new Error(`文件锁进程提前退出（${code}）：${errors}`));
      });
    });

    await assert.rejects(collectInstallers(options), /已恢复原安装包和清单/);
    assert.equal(await readFile(join(destination, msiName), "utf8"), "old msi fixture");
    assert.equal(await readFile(join(destination, exeName), "utf8"), "old exe fixture");
    const restoredManifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
    assert.deepEqual(restoredManifest, original);
    for (const file of restoredManifest.files) {
      const bytes = await readFile(join(destination, file.name));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    }
    assert.equal((await readdir(destination)).some(name => name.startsWith(".staging-")), false);
  } finally {
    worker.stdin.end("\n");
    await workerExit;
  }
});
