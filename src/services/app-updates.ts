/**
 * 更新检查是确定性的应用能力，独立于 Agent、API Key 和 React 生命周期。
 * 本服务只读取公开正式 Release；安装由用户下载后确认，避免引入更新签名密钥。
 */
export const APP_RELEASES_URL = "https://github.com/a985987819/MoChi/releases";
const LATEST_RELEASE_API = "https://api.github.com/repos/a985987819/MoChi/releases/latest";

/** 未识别系统时保留发布页入口，不猜测能否运行某个安装包。 */
export type UpdatePlatform = "windows" | "mac" | "unsupported";
export type UpdateArchitecture = "x64" | "arm64" | "unknown";

export interface AppUpdateRelease {
  version: string;
  name: string;
  notes: string;
  publishedAt: string;
  releaseUrl: string;
}

export interface AppUpdateInstaller {
  name: string;
  url: string;
  size: number;
}

/** 区分「无公开版本」与「无需升级」，防止草稿发布阶段出现虚假的成功提示。 */
export type AppUpdateResult =
  | { kind: "available"; release: AppUpdateRelease; installer: AppUpdateInstaller | null }
  | { kind: "current"; release: AppUpdateRelease; relation: "same" | "ahead" }
  | { kind: "unpublished"; message: string }
  | { kind: "error"; message: string; code: "version" | "http" | "rate-limit" | "invalid-response" | "network" | "timeout" }
  | { kind: "cancelled" };

export interface AppUpdateOptions {
  currentVersion: string;
  platform: UpdatePlatform;
  architecture?: UpdateArchitecture;
  signal?: AbortSignal;
  /** 注入网络边界即可测真实协议分支，无须启动原生窗口。 */
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

interface Version {
  core: string[];
  prerelease: string[];
}

function parseVersion(value: string): Version | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  // SemVer 的纯数字预发布标识同样禁止前导零；构建元数据不参与先后比较。
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { core: [match[1], match[2], match[3]], prerelease };
}

function compareNumeric(left: string, right: string): number {
  // 不转 Number，避免超大版本号越过安全整数边界后被误判为相等。
  return left.length === right.length ? (left === right ? 0 : left > right ? 1 : -1) : left.length > right.length ? 1 : -1;
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 3; index++) {
    const compared = compareNumeric(left.core[index], right.core[index]);
    if (compared !== 0) return compared;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const one = left.prerelease[index];
    const two = right.prerelease[index];
    if (one === undefined || two === undefined) return one === undefined ? -1 : 1;
    if (one === two) continue;
    const numericOne = /^\d+$/.test(one);
    const numericTwo = /^\d+$/.test(two);
    if (numericOne && numericTwo) return compareNumeric(one, two);
    if (numericOne !== numericTwo) return numericOne ? -1 : 1;
    return one > two ? 1 : -1;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 系统识别只决定下载建议；架构未知时 macOS 只推荐通用包。 */
export function detectUpdatePlatform(platformText: string): UpdatePlatform {
  // Darwin 含有 win 子串，必须先识别 macOS，不能用包含 win 的朴素匹配。
  if (/mac|darwin/i.test(platformText)) return "mac";
  if (/\bwin(?:dows|32|64)?\b/i.test(platformText)) return "windows";
  return "unsupported";
}

function trustedAssetUrl(raw: unknown, tag: string, name: string): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.split("/").map(part => decodeURIComponent(part));
    if (parts.length !== 7 || parts[1].toLowerCase() !== "a985987819" || parts[2].toLowerCase() !== "mochi"
      || parts[3] !== "releases" || parts[4] !== "download" || parts[5] !== tag || parts[6] !== name) return null;
    return url.href;
  } catch {
    return null;
  }
}

function selectInstaller(assets: unknown[], tag: string, options: AppUpdateOptions): AppUpdateInstaller | null {
  const version = tag.replace(/^v/, "");
  const architecture = options.architecture ?? "unknown";
  const candidates: { installer: AppUpdateInstaller; rank: number }[] = [];
  for (const asset of assets) {
    if (!isRecord(asset) || typeof asset.name !== "string" || typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) continue;
    const name = asset.name;
    const lower = name.toLowerCase();
    // 文件名必须含当前 Release 的精确版本，防止误下载同页遗留的旧版或源码。
    if (!lower.startsWith(`mochi_${version.toLowerCase()}_`)) continue;
    let rank = 0;
    if (options.platform === "windows") {
      const arch = architecture === "arm64" ? "arm64" : "x64";
      if (lower === `mochi_${version.toLowerCase()}_${arch}-setup.exe`) rank = 30;
      else if (lower.startsWith(`mochi_${version.toLowerCase()}_${arch}_`) && lower.endsWith(".msi")) rank = 20;
    } else if (options.platform === "mac" && lower.endsWith(".dmg")) {
      if (lower === `mochi_${version.toLowerCase()}_universal.dmg`) rank = 30;
      else if (architecture === "arm64" && lower === `mochi_${version.toLowerCase()}_aarch64.dmg`) rank = 20;
      else if (architecture === "x64" && lower === `mochi_${version.toLowerCase()}_x64.dmg`) rank = 20;
    }
    if (rank === 0) continue;
    const url = trustedAssetUrl(asset.browser_download_url, tag, name);
    if (url) candidates.push({ rank, installer: { name, size: asset.size, url } });
  }
  candidates.sort((left, right) => right.rank - left.rank || left.installer.name.localeCompare(right.installer.name));
  return candidates[0]?.installer ?? null;
}

function parseRelease(raw: unknown, options: AppUpdateOptions, current: Version): AppUpdateResult {
  if (!isRecord(raw) || typeof raw.tag_name !== "string" || typeof raw.draft !== "boolean"
    || typeof raw.prerelease !== "boolean" || !Array.isArray(raw.assets)) {
    return { kind: "error", code: "invalid-response", message: "更新信息格式不正确，请稍后重试或查看发布页。" };
  }
  const version = parseVersion(raw.tag_name);
  if (!version) return { kind: "error", code: "invalid-response", message: "发布版本号无法识别，请前往发布页查看。" };
  if (raw.draft || raw.prerelease || version.prerelease.length > 0) {
    return { kind: "unpublished", message: "暂未找到可获取的公开正式版本，可前往发布页查看。" };
  }
  const release: AppUpdateRelease = {
    version: raw.tag_name.replace(/^v/, ""),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.slice(0, 200) : `Mochi ${raw.tag_name}`,
    notes: typeof raw.body === "string" && raw.body.trim() ? raw.body.slice(0, 20_000) : "这个版本还没有填写更新说明。",
    publishedAt: typeof raw.published_at === "string" && Number.isFinite(Date.parse(raw.published_at)) ? raw.published_at : "",
    // 从受校验的 tag 构造项目内链接，不把远端任意 html_url 交给系统 opener。
    releaseUrl: `${APP_RELEASES_URL}/tag/${encodeURIComponent(raw.tag_name)}`,
  };
  const comparison = compareVersions(version, current);
  if (comparison <= 0) return { kind: "current", release, relation: comparison === 0 ? "same" : "ahead" };
  return { kind: "available", release, installer: selectInstaller(raw.assets, raw.tag_name, options) };
}

/**
 * 用户点击才发起匿名、无凭据的更新检查；fetch 和响应体共享超时/取消边界。
 * 失败转为可重试的产品状态，不向 UI 暴露网络异常文本或改变安装状态。
 */
export async function checkForAppUpdate(options: AppUpdateOptions): Promise<AppUpdateResult> {
  const current = parseVersion(options.currentVersion);
  if (!current) return { kind: "error", code: "version", message: "无法识别当前应用版本，请前往发布页查看。" };
  if (options.signal?.aborted) return { kind: "cancelled" };
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); },
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 12_000);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new Error("update request aborted"));
    controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const request = async (): Promise<AppUpdateResult> => {
      const response = await (options.fetcher ?? fetch)(LATEST_RELEASE_API, {
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 404) return { kind: "unpublished", message: "暂未找到可获取的公开正式版本，可前往发布页查看。" };
      if (response.status === 403 || response.status === 429) return {
        kind: "error", code: "rate-limit", message: "更新服务暂时限制访问，请稍后重试，也可以直接查看发布页。",
      };
      if (!response.ok) return { kind: "error", code: "http", message: "更新服务暂时不可用，请稍后重试。" };
      let raw: unknown;
      try { raw = await response.json(); }
      catch { return { kind: "error", code: "invalid-response", message: "更新信息暂时无法读取，请稍后重试。" }; }
      return parseRelease(raw, options, current);
    };
    // race 也覆盖不遵守 AbortSignal 的适配器，UI 卸载和网络挂起均能及时结束。
    return await Promise.race([request(), aborted]);
  } catch {
    if (options.signal?.aborted) return { kind: "cancelled" };
    if (timedOut) return { kind: "error", code: "timeout", message: "检查更新超时，请检查网络后重试。" };
    return { kind: "error", code: "network", message: "暂时连不上更新服务，请检查网络后重试。" };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}
