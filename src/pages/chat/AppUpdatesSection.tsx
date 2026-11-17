import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  APP_RELEASES_URL,
  checkForAppUpdate,
  detectUpdatePlatform,
  type AppUpdateResult,
} from "@/services/app-updates";
import { useT } from "@/shared/i18n/react";
import "./app-updates.css";

type UpdateState = { kind: "idle" | "checking" } | AppUpdateResult;

/**
 * 版本更新是应用能力：服务负责判版本和选包，组件只负责用户反馈。
 * 仅在用户点击时访问公开发布信息；切走设置页会取消请求，避免过期回包覆盖新界面。
 * 下载交给系统浏览器，让用户自行覆盖安装，不把「打开下载页」误报成「更新已完成」。
 * v0.21.0：文案迁入 i18n（updates.*）。
 */
export function AppUpdatesSection() {
  const { t } = useT();
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
        ? { kind: "error", code: "version", message: t("updates.versionReadFail") }
        : previous);
    });
    return () => {
      mounted.current = false;
      openAttempt.current += 1;
      activeRequest.current?.abort();
    };
  }, [t]);

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
        setState({ kind: "error", code: "version", message: t("updates.versionReadFail") });
      }
    }
  }, [platform, version, t]);

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
  const message = state.kind === "checking" ? t("updates.checking")
    : state.kind === "available" ? t("updates.available", { version: state.release.version })
    : state.kind === "current" ? t("updates.current", { version: state.release.version })
    : state.kind === "unpublished" ? t("updates.unpublished")
    : state.kind === "error" ? state.message
    : t("updates.tagline");
  const installerLabel = platform === "windows" ? t("updates.installerWin") : t("updates.installerMac");

  return (
    <section className="settings-update" aria-labelledby="app-update-title" aria-busy={state.kind === "checking"}>
      <div className="settings-update__header">
        <div>
          <h2 id="app-update-title">{t("updates.title")}</h2>
          <p className="settings-update__version">Mochi <span>v{version || "…"}</span></p>
        </div>
        <button className="settings-ghost-btn" onClick={() => void check()} disabled={state.kind === "checking"}>
          {state.kind === "checking" ? t("updates.checkingBtn") : state.kind === "error" ? t("updates.recheck") : t("updates.check")}
        </button>
      </div>
      <p className={`settings-update__status${state.kind === "error" ? " settings-update__status--error" : ""}`} role="status">
        {message}
      </p>
      {available && (
        <div className="settings-update__available">
          <button className="settings-update__download" onClick={() => void openDownload(available.installer?.url ?? available.release.releaseUrl, available.installer ? "download" : "release")}>
            {available.installer ? t("updates.downloadInstaller", { installer: installerLabel }) : t("updates.goRelease")}
            {available.installer && available.installer.size > 0 && <span> · {(available.installer.size / 1024 / 1024).toFixed(1)} MB</span>}
          </button>
          {!available.installer && <p className="settings-note">{t("updates.noInstaller")}</p>}
        </div>
      )}
      {release && (
        <details className="settings-update__details" open={state.kind === "available"}>
          <summary>{t("updates.releaseNotes", { version: release.version })}</summary>
          {/* 按纯文本展示远程说明，避免远程 HTML 或链接绕过下载地址校验。 */}
          <div className="settings-update__notes" tabIndex={0} role="region" aria-label={t("updates.notesAria", { version: release.version })}>{release.notes || t("updates.notesEmpty")}</div>
        </details>
      )}
      <details className="settings-update__details">
        <summary>{t("updates.howToUpdate")}</summary>
        <ol className="settings-update__steps">
          <li>{t("updates.stepDownload")}</li>
          <li>{t("updates.stepQuit")}</li>
          <li>{platform === "mac" ? t("updates.stepInstallMac")
            : platform === "windows" ? t("updates.stepInstallWin") : t("updates.stepInstallGeneric")}</li>
          <li>{t("updates.stepReopen")}</li>
        </ol>
        <p className="settings-note">{t("updates.keepData")}</p>
      </details>
      <button className="settings-link settings-update__release-link" onClick={() => void openDownload(APP_RELEASES_URL)}>{t("updates.allReleases")}</button>
      {opened && <p className="settings-update__feedback" role="status">{opened === "download"
        ? t("updates.openedDownload")
        : t("updates.openedRelease")}</p>}
      {failedUrl && (
        <label className="settings-update__fallback" role="alert">
          {t("updates.browserFail")}
          <input aria-label={t("updates.downloadUrlAria")} value={failedUrl} readOnly onFocus={event => event.currentTarget.select()} />
        </label>
      )}
    </section>
  );
}
