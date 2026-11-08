import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  APP_RELEASES_URL,
  checkForAppUpdate,
  detectUpdatePlatform,
  type AppUpdateResult,
} from "@/services/app-updates";
import "./app-updates.css";

type UpdateState = { kind: "idle" | "checking" } | AppUpdateResult;

/**
 * 版本更新是应用能力：服务负责判版本和选包，组件只负责用户反馈。
 * 仅在用户点击时访问公开发布信息；切走设置页会取消请求，避免过期回包覆盖新界面。
 * 下载交给系统浏览器，让用户自行覆盖安装，不把「打开下载页」误报成「更新已完成」。
 */
export function AppUpdatesSection() {
  const [version, setVersion] = useState("");
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [opened, setOpened] = useState<"download" | "release" | null>(null);
  const [failedUrl, setFailedUrl] = useState("");
  const activeRequest = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const openAttempt = useRef(0);
  const platform = detectUpdatePlatform(navigator.platform || navigator.userAgent);

  useEffect(() => {
    mounted.current = true;
    void getVersion().then(value => { if (mounted.current) setVersion(value); }).catch(() => {
      // 初始读取与用户主动重试可能并发，旧失败不能覆盖新的检查结果。
      if (mounted.current) setState(previous => previous.kind === "idle"
        ? { kind: "error", code: "version", message: "无法读取当前版本，请重试检查更新。" }
        : previous);
    });
    return () => {
      mounted.current = false;
      openAttempt.current += 1;
      activeRequest.current?.abort();
    };
  }, []);

  const check = useCallback(async () => {
    activeRequest.current?.abort();
    const request = new AbortController();
    activeRequest.current = request;
    setState({ kind: "checking" });
    openAttempt.current += 1;
    setOpened(null);
    setFailedUrl("");
    try {
      const currentVersion = version || await getVersion();
      if (request.signal.aborted) return;
      setVersion(currentVersion);
      const result = await checkForAppUpdate({ currentVersion, platform, signal: request.signal });
      if (!request.signal.aborted) setState(result);
    } catch {
      if (!request.signal.aborted) {
        setState({ kind: "error", code: "version", message: "无法读取当前版本，请重试检查更新。" });
      }
    }
  }, [platform, version]);

  const openDownload = useCallback(async (url: string, kind: "download" | "release" = "release") => {
    const attempt = ++openAttempt.current;
    setFailedUrl("");
    setOpened(null);
    try {
      await openUrl(url);
      if (mounted.current && attempt === openAttempt.current) setOpened(kind);
    } catch {
      // 系统未配置浏览器时，保留可复制的完整地址，仍能继续更新。
      if (mounted.current && attempt === openAttempt.current) setFailedUrl(url);
    }
  }, []);

  const available = state.kind === "available" ? state : null;
  const release = state.kind === "available" || state.kind === "current" ? state.release : null;
  const message = state.kind === "checking" ? "正在检查公开发布的正式版本…"
    : state.kind === "available" ? `发现新版本 v${state.release.version}`
    : state.kind === "current" ? `当前版本无需更新，公开正式版为 v${state.release.version}。`
    : state.kind === "unpublished" ? "暂时没有公开的正式版本，发布后可在这里检查。"
    : state.kind === "error" ? state.message
    : "让麻薯保持新鲜，也让熟悉的陪伴留在身边。";
  const installerLabel = platform === "windows" ? "Windows 安装包" : "macOS 安装包";

  return (
    <section className="settings-update" aria-labelledby="app-update-title" aria-busy={state.kind === "checking"}>
      <div className="settings-update__header">
        <div>
          <h2 id="app-update-title">版本与更新</h2>
          <p className="settings-update__version">Mochi <span>v{version || "…"}</span></p>
        </div>
        <button className="settings-ghost-btn" onClick={() => void check()} disabled={state.kind === "checking"}>
          {state.kind === "checking" ? "检查中…" : state.kind === "error" ? "重新检查" : "检查更新"}
        </button>
      </div>
      <p className={`settings-update__status${state.kind === "error" ? " settings-update__status--error" : ""}`} role="status">
        {message}
      </p>
      {available && (
        <div className="settings-update__available">
          <button className="settings-update__download" onClick={() => void openDownload(available.installer?.url ?? available.release.releaseUrl, available.installer ? "download" : "release")}>
            {available.installer ? `下载 ${installerLabel}` : "前往发布页查看下载"}
            {available.installer && available.installer.size > 0 && <span> · {(available.installer.size / 1024 / 1024).toFixed(1)} MB</span>}
          </button>
          {!available.installer && <p className="settings-note">暂未找到适合本机的安装包，请在发布页确认系统与芯片类型。</p>}
        </div>
      )}
      {release && (
        <details className="settings-update__details" open={state.kind === "available"}>
          <summary>v{release.version} 更新说明</summary>
          {/* 按纯文本展示远程说明，避免远程 HTML 或链接绕过下载地址校验。 */}
          <div className="settings-update__notes" tabIndex={0} role="region" aria-label={`v${release.version} 更新说明正文`}>{release.notes || "本版本暂无详细说明，可到发布页查看。"}</div>
        </details>
      )}
      <details className="settings-update__details">
        <summary>如何更新并保留数据</summary>
        <ol className="settings-update__steps">
          <li>下载适合本机的新版本安装包。</li>
          <li>从托盘菜单退出 Mochi，避免文件被占用。</li>
          <li>{platform === "mac" ? "打开 DMG，将 Mochi 拖入「应用程序」并替换旧版本。"
            : platform === "windows" ? "运行安装包，使用原来的安装位置覆盖安装。" : "按发布页提供的系统安装说明完成更新。"}</li>
          <li>重新打开 Mochi，在这里核对版本号。</li>
        </ol>
        <p className="settings-note">正常覆盖安装会保留聊天、待办、设置和自定义素材。更新前可通过下方「打开数据目录」备份。</p>
      </details>
      <button className="settings-link settings-update__release-link" onClick={() => void openDownload(APP_RELEASES_URL)}>查看所有发布版本</button>
      {opened && <p className="settings-update__feedback" role="status">{opened === "download"
        ? "已在浏览器打开下载。下载完成后，请按上方步骤安装。"
        : "已在浏览器打开发布页，请选择适合本机的安装包。"}</p>}
      {failedUrl && (
        <label className="settings-update__fallback" role="alert">
          浏览器未能打开，请复制地址访问：
          <input aria-label="更新下载地址" value={failedUrl} readOnly onFocus={event => event.currentTarget.select()} />
        </label>
      )}
    </section>
  );
}
