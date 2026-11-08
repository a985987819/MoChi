import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_RELEASES_URL, checkForAppUpdate, detectUpdatePlatform } from "@/services/app-updates";
import type { AppUpdateOptions } from "@/services/app-updates";

const tag = "v0.10.0";

function asset(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name, size: 3_000_000,
    browser_download_url: `https://github.com/a985987819/MoChi/releases/download/${tag}/${encodeURIComponent(name)}`,
    ...overrides,
  };
}

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: tag, name: "Mochi v0.10.0", body: "修复提醒并改善使用体验。",
    draft: false, prerelease: false, published_at: "2026-11-06T01:00:00Z",
    assets: [asset("Mochi_0.10.0_x64-setup.exe")], ...overrides,
  };
}

function check(raw: unknown = release(), options: Partial<AppUpdateOptions> = {}, status = 200) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(raw), { status }));
  return {
    fetcher,
    result: checkForAppUpdate({ currentVersion: "0.9.0", platform: "windows", fetcher, ...options }),
  };
}

afterEach(() => vi.useRealTimers());

describe("app updates: version and public-release protocol", () => {
  it("按数值比较0.10与0.9，并匿名请求GitHub正式版本契约", async () => {
    const { fetcher, result } = check();
    const update = await result;
    expect(update).toMatchObject({ kind: "available", release: { version: "0.10.0", notes: "修复提醒并改善使用体验。" } });
    expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/a985987819/MoChi/releases/latest", expect.objectContaining({
      credentials: "omit", cache: "no-store", headers: expect.objectContaining({ Accept: "application/vnd.github+json" }),
    }));
  });

  it.each([
    ["0.10.0", "same"], ["v0.10.0+local.7", "same"], ["0.11.0", "ahead"],
    ["1.0.0", "ahead"], ["90071992547409930000.0.0", "ahead"],
  ])("本地版本%s不会被要求降级（%s）", async (currentVersion, relation) => {
    expect(await check(release(), { currentVersion }).result).toMatchObject({ kind: "current", relation });
  });

  it.each(["0.10.0-rc.1", "0.10.0-beta.20+local", "0.9.99"])("正式版可升级本地%s", async currentVersion => {
    expect(await check(release(), { currentVersion }).result).toMatchObject({ kind: "available" });
  });

  it.each(["0.09.0", "0.9", "garbage", "0.9.0-01", "0.9.0-"])("不猜测非法当前版本%s", async currentVersion => {
    const { result, fetcher } = check(release(), { currentVersion });
    expect(await result).toMatchObject({ kind: "error", code: "version" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("404表示暂无可获取的公开正式版，不伪装为已经最新", async () => {
    expect(await check({ message: "Not Found" }, {}, 404).result).toMatchObject({ kind: "unpublished" });
  });

  it.each([{ draft: true }, { prerelease: true }, { tag_name: "v0.10.0-rc.1" }])("二次过滤草稿或预发布：%j", async patch => {
    expect(await check(release(patch)).result).toMatchObject({ kind: "unpublished" });
  });

  it.each([null, [], "bad", { tag_name: tag }, release({ tag_name: "nightly" }), release({ assets: null }), release({ draft: "false" })])("远端unknown经过运行时校验：%j", async raw => {
    expect(await check(raw).result).toMatchObject({ kind: "error", code: "invalid-response" });
  });

  it("构造可信发布页，不使用远端任意html_url；缺说明有占位、坏日期留空", async () => {
    expect(await check(release({ html_url: "javascript:alert(1)", body: null, published_at: "bad" })).result).toMatchObject({
      kind: "available", release: { releaseUrl: `${APP_RELEASES_URL}/tag/v0.10.0`, publishedAt: "", notes: "这个版本还没有填写更新说明。" },
    });
  });
});

describe("app updates: installer choice", () => {
  const names = [
    "Mochi_0.10.0_x64_en-US.msi", "Mochi_0.10.0_universal.dmg", "Mochi_0.10.0_x64-setup.exe",
    "Mochi_0.10.0_aarch64.dmg", "Mochi_0.10.0_x64.dmg", "Mochi_universal.app.tar.gz", "Source_code.zip",
  ];

  it("Windows优先NSIS，其次MSI；不选择Mac包或源码", async () => {
    expect(await check(release({ assets: names.map(name => asset(name)) })).result).toMatchObject({
      kind: "available", installer: { name: "Mochi_0.10.0_x64-setup.exe" },
    });
    expect(await check(release({ assets: names.filter(name => !name.endsWith(".exe")).map(name => asset(name)) })).result).toMatchObject({
      kind: "available", installer: { name: "Mochi_0.10.0_x64_en-US.msi" },
    });
  });

  it("macOS优先通用dmg，明确架构时才选择单架构包", async () => {
    expect(await check(release({ assets: names.map(name => asset(name)) }), { platform: "mac", architecture: "arm64" }).result).toMatchObject({
      kind: "available", installer: { name: "Mochi_0.10.0_universal.dmg" },
    });
    const single = release({ assets: [asset("Mochi_0.10.0_aarch64.dmg"), asset("Mochi_0.10.0_x64.dmg")] });
    expect(await check(single, { platform: "mac", architecture: "arm64" }).result).toMatchObject({
      kind: "available", installer: { name: "Mochi_0.10.0_aarch64.dmg" },
    });
    expect(await check(single, { platform: "mac", architecture: "x64" }).result).toMatchObject({
      kind: "available", installer: { name: "Mochi_0.10.0_x64.dmg" },
    });
    expect(await check(single, { platform: "mac" }).result).toMatchObject({ kind: "available", installer: null });
  });

  it("不拿旧版文件冒充本次Release；无匹配包或未知系统时保留发布页", async () => {
    expect(await check(release({ assets: [asset("Mochi_0.9.0_x64-setup.exe"), asset("Source_code.zip")] })).result).toMatchObject({
      kind: "available", installer: null, release: { releaseUrl: `${APP_RELEASES_URL}/tag/${tag}` },
    });
    expect(await check(release(), { platform: "unsupported" }).result).toMatchObject({ kind: "available", installer: null });
  });

  it.each([
    "http://github.com/a985987819/MoChi/releases/download/v0.10.0/Mochi_0.10.0_x64-setup.exe",
    "https://github.com.evil.test/a985987819/MoChi/releases/download/v0.10.0/Mochi_0.10.0_x64-setup.exe",
    "https://github.com/another/repo/releases/download/v0.10.0/Mochi_0.10.0_x64-setup.exe",
    "https://github.com/a985987819/MoChi/releases/download/v0.9.0/Mochi_0.10.0_x64-setup.exe",
    "https://github.com/a985987819/MoChi/releases/download/v0.10.0/other.exe",
    "https://user:password@github.com/a985987819/MoChi/releases/download/v0.10.0/Mochi_0.10.0_x64-setup.exe",
    "javascript:alert(1)", "file:///tmp/setup.exe",
  ])("拒绝不可信或错配安装包URL：%s", async url => {
    expect(await check(release({ assets: [asset("Mochi_0.10.0_x64-setup.exe", { browser_download_url: url })] })).result).toMatchObject({
      kind: "available", installer: null,
    });
  });

  it("非法尺寸不作为可下载包；正确大小与URL返回UI", async () => {
    for (const size of [0, -1, "30000", Number.NaN]) {
      expect(await check(release({ assets: [asset("Mochi_0.10.0_x64-setup.exe", { size })] })).result).toMatchObject({ kind: "available", installer: null });
    }
    expect(await check().result).toMatchObject({ kind: "available", installer: { size: 3_000_000, url: expect.stringContaining("https://github.com/") } });
  });

  it("系统识别不把Linux误判为Mac", () => {
    expect(detectUpdatePlatform("Win32")).toBe("windows");
    expect(detectUpdatePlatform("macOS")).toBe("mac");
    expect(detectUpdatePlatform("MacIntel")).toBe("mac");
    expect(detectUpdatePlatform("Darwin")).toBe("mac");
    expect(detectUpdatePlatform("Linux x86_64")).toBe("unsupported");
  });
});

describe("app updates: recoverable failures and cancellation", () => {
  it.each([403, 429])("HTTP %s限流可重试", async status => {
    expect(await check({}, {}, status).result).toMatchObject({ kind: "error", code: "rate-limit" });
  });

  it("HTTP 500与断网均返回友好错误，不泄漏原始异常", async () => {
    expect(await check({}, {}, 500).result).toMatchObject({ kind: "error", code: "http" });
    const fetcher = vi.fn(async (): Promise<Response> => { throw new Error("private raw network diagnostic"); });
    expect(await check(release(), { fetcher }).result).toEqual({ kind: "error", code: "network", message: "暂时连不上更新服务，请检查网络后重试。" });
  });

  it("坏JSON可以重试", async () => {
    const fetcher = vi.fn(async () => new Response("not-json"));
    expect(await check(release(), { fetcher }).result).toMatchObject({ kind: "error", code: "invalid-response" });
  });

  it("外部取消立即结束，且下一次检查正常", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const pending = check(release(), { fetcher, signal: controller.signal }).result;
    controller.abort();
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(await check().result).toMatchObject({ kind: "available" });
    const cancelled = check(release(), { signal: controller.signal });
    expect(await cancelled.result).toEqual({ kind: "cancelled" });
    expect(cancelled.fetcher).not.toHaveBeenCalled();
  });

  it("即使适配器忽略AbortSignal，也有超时并释放定时器", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const pending = check(release(), { fetcher, timeoutMs: 100 }).result;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ kind: "error", code: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("响应头已返回但body卡住时同样超时", async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = vi.fn(async () => new Response(new ReadableStream()));
    const pending = check(release(), { fetcher, timeoutMs: 100 }).result;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ kind: "error", code: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
