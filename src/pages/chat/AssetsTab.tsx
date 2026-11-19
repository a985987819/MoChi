import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appDataDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  STATE_DOCS,
  deleteUserPetAsset,
  exportPetAssets,
  extOfFileName,
  fileNameOf,
  frameOfFileName,
  guessStateFromFileName,
  listUserAssets,
  readFileAsBase64,
  savePetAsset,
  targetFileName,
} from "@/services/pet-asset-import";
import type { PetState } from "@/services/pet-state";
import { useT } from "@/shared/i18n/react";
import "./assets.css";

/**
 * 素材 Tab（v0.9.2）—— 双语「图片导入」页。
 *
 * # 为什么需要这一页
 *
 * 在此之前，自定义素材只能靠用户自己把文件放进 `pet-assets/` 并**手写英文状态名**
 * （`happy.png`）。中文名（`开心.png`）永远不会命中状态机——用户不知道，只会觉得
 * 「放了图没反应」。这一页把三件事补上：
 * ① 讲清楚十个状态各自代表什么时刻（中英双语，导入前先知道自己在配什么）；
 * ② 从文件名认状态（开心.png → happy），并把用户的选择放在确认列表里；
 * ③ 落盘时**统一改成英文规范名**（`happy.png` / `happy_2.png`），项目直接可用。
 *
 * # 交互设计：先确认再落盘
 *
 * 选完文件不立刻写入，而是列出「原文件名 → 目标英文名 + 状态下拉」。理由：改名是
 * 不可逆的用户素材操作，猜错状态比多一次点击更糟；确认列表还顺手把"中文名会变成什么"
 * 演示给用户看。写盘本身由 Rust 负责（前端无文件系统权限，见 AGENTS.md）。
 */

interface PendingFile {
  id: number;
  file: File;
  /** 原文件名（对照用：开心.png → happy.png） */
  from: string;
  /** 归一后的扩展名（jpeg → jpg） */
  ext: string;
  state: PetState;
  /** true = 状态由文件名猜出；false = 认不出，用默认待机并提示手选 */
  guessed: boolean;
  /**
   * 源文件里的帧号（`开心_001.png` → 1）。非 null 时导入后保留 `_001` 形式，
   * 多帧同状态会组成逐帧动画；null 则按普通变体处理。
   */
  frame: number | null;
}

interface Notice {
  tone: "ok" | "error";
  text: string;
}

export function AssetsTab() {
  const { t, locale } = useT();
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [existing, setExisting] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  /** 用户素材完整路径（缩略图/删除用，v0.24.0） */
  const [userPaths, setUserPaths] = useState<Record<string, string[]>>({});
  /** 两步删除的待确认项（完整路径） */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 一键导出（v0.29.1）：Rust 打 zip 期间禁用按钮，避免重复点击生成多个包 */
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** 每状态独立上传（v0.23.0）：非 null 时本次选择的文件全部归入该状态 */
  const uploadTarget = useRef<PetState | null>(null);
  /** 点击复制命名的反馈（state+形态 键，1.2s 后回落） */
  const [copiedName, setCopiedName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  /** 读一次用户目录：文件名用于规划变体序号，计数用于状态卡片上的"已有 N 张" */
  const refresh = useCallback(() => {
    void listUserAssets().then(map => {
      const names = Object.values(map).flat().map(fileNameOf);
      setExisting(names);
      setCounts(Object.fromEntries(Object.entries(map).map(([state, paths]) => [state, paths.length])));
      setUserPaths(map); // 缩略图/删除（v0.24.0）
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** 删除一张素材（v0.24.0）：两步确认后调 Rust 删除并重扫；失败给可见提示 */
  const removeAsset = useCallback(
    (path: string) => {
      setDeleting(true);
      void deleteUserPetAsset(path)
        .then(() => {
          setPendingDelete(null);
          refresh();
        })
        .catch(() => setNotice({ tone: "error", text: t("assets.deleteFail") }))
        .finally(() => setDeleting(false));
    },
    [t, refresh],
  );

  /** 选文件：只做识别与规划，不写盘（写盘在「导入」里，用户先确认状态）。
   *  v0.23.0：每状态独立上传——target 非 null 时全部文件归入该状态（帧号仍从
   *  文件名识别），猜名逻辑只在「选择图片」通用入口生效。 */
  const onFilesPicked = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return;
    const target = uploadTarget.current;
    const accepted: PendingFile[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(list)) {
      const ext = extOfFileName(file.name);
      if (!ext) {
        rejected.push(file.name);
        continue;
      }
      const guessedState = guessStateFromFileName(file.name);
      accepted.push({
        id: nextId.current++,
        file,
        from: file.name,
        ext,
        state: target ?? guessedState ?? "idle",
        guessed: target !== null ? true : guessedState !== null,
        frame: frameOfFileName(file.name),
      });
    }
    setPending(prev => [...prev, ...accepted]);
    setNotice(
      rejected.length > 0
        ? {
            tone: "error",
            text: t("assets.rejected", {
              count: rejected.length,
              names: rejected.slice(0, 3).join("、") + (rejected.length > 3 ? "…" : ""),
            }),
          }
        : null,
    );
  }, [t]);

  /** 打开文件选择器：target 非 null = 为指定状态上传（v0.23.0 每状态独立上传） */
  const pickFiles = useCallback((target: PetState | null) => {
    uploadTarget.current = target;
    inputRef.current?.click();
  }, []);

  /** 点击复制命名（v0.23.0）：把规范文件名写进剪贴板，1.2s 后反馈回落 */
  const copyName = useCallback((name: string) => {
    void navigator.clipboard
      .writeText(name)
      .then(() => {
        setCopiedName(name);
        window.setTimeout(() => setCopiedName(prev => (prev === name ? null : prev)), 1200);
      })
      .catch(() => undefined);
  }, []);

  /** 目标文件名预览：与 Rust 同算法，且同批内递增，避免两张图抢同一个名字 */
  const planned = useMemo(() => {
    const reserved: string[] = [];
    return pending.map(item => {
      const name = targetFileName(item.state, item.ext, existing, reserved, item.frame);
      reserved.push(name);
      return name;
    });
  }, [pending, existing]);

  /** 本批里的帧按状态分组：同状态 >= 2 帧才会真正组成逐帧动画 */
  const sequenceStates = useMemo(() => {
    const byState = new Map<PetState, number>();
    for (const item of pending) {
      if (item.frame !== null) byState.set(item.state, (byState.get(item.state) ?? 0) + 1);
    }
    return [...byState.entries()].filter(([, count]) => count >= 2).map(([state]) => state);
  }, [pending]);

  const importAll = useCallback(async () => {
    if (pending.length === 0 || busy) return;
    setBusy(true);
    setNotice(null);
    const saved: string[] = [];
    const failed: string[] = [];
    for (const item of pending) {
      try {
        const base64 = await readFileAsBase64(item.file);
        saved.push(await savePetAsset(item.state, item.ext, base64, item.frame));
      } catch (error) {
        failed.push(`${item.from}（${error instanceof Error ? error.message : String(error)}）`);
      }
    }
    setBusy(false);
    setPending([]);
    refresh();
    setNotice(
      failed.length === 0
        ? {
            tone: "ok",
            text: t("assets.imported", {
              count: saved.length,
              names: saved.slice(0, 4).join("、") + (saved.length > 4 ? "…" : ""),
            }),
          }
        : { tone: "error", text: t("assets.partial", { ok: saved.length, failed: failed.length, names: failed.slice(0, 2).join("；") }) },
    );
  }, [pending, busy, refresh, t]);

  const openFolder = useCallback(async () => {
    try {
      const dir = await join(await appDataDir(), "pet-assets");
      await revealItemInDir(dir);
    } catch {
      try {
        await revealItemInDir(await appDataDir());
      } catch {
        setNotice({ tone: "error", text: t("assets.openFail") });
      }
    }
  }, [t]);

  /**
   * 一键导出当前素材（v0.29.1）：Rust 生成 zip 后直接 reveal 到资源管理器/Finder。
   * 导出内容与运行时回退链一致——有用户素材导用户素材，没有则导内置默认图。
   */
  const exportAll = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setNotice(null);
    try {
      const result = await exportPetAssets();
      setNotice({
        tone: "ok",
        text: `${t("assets.exported", {
          count: result.count,
          path: result.path,
          source: t(result.source === "user" ? "assets.exportSourceUser" : "assets.exportSourceBundled"),
        })} ${t("assets.exportedNext")}`,
      });
      await revealItemInDir(result.path).catch(() => undefined);
    } catch (error) {
      setNotice({
        tone: "error",
        text: t("assets.exportFail", {
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      setExporting(false);
    }
  }, [exporting, t]);

  return (
    <div className="assets-page">
      <header className="assets-head">
        <h2>
          宠物素材
          <span className="assets-en">Pet assets</span>
        </h2>
        <div className="assets-head__actions">
          <button
            id="assets-export-button"
            className="assets-export"
            onClick={() => void exportAll()}
            disabled={exporting || busy}
            title={t("assets.exportHint")}
          >
            {exporting ? t("assets.exporting") : t("assets.exportAll")}
          </button>
          <button id="assets-open-folder" className="assets-link" onClick={() => void openFolder()}>
            打开目录 / Open folder
          </button>
        </div>
      </header>

      <p className="assets-lead">
        导入的图片会自动改成<strong>英文文件名</strong>（<code>happy.png</code>、
        <code>happy_2.png</code>）再放进项目素材目录——项目只认英文状态名，中文名的图不会生效。
        文件名带三位序号（<code>开心_001.png</code>）的会按<strong>逐帧动画</strong>保留序号。
      </p>
      <p className="assets-lead assets-lead--en">
        Imported images are renamed to the English state codes automatically
        (<code>happy.png</code>, <code>happy_2.png</code>). Chinese file names are detected and translated for you.
      </p>

      <p className="assets-lead">
        同一状态可以放多张图片（自动命名 <code>happy_2.png</code>、<code>happy_3.png</code>…），
        宠物每 <strong>5 分钟</strong>随机换一张静态图；点下方命名可复制。
        <br />
        Multiple images per state are auto-numbered (<code>happy_2.png</code>…) and a random static one is picked every 5 minutes.
      </p>

      {/* 导入导出说明（v0.29.5）：导出的 zip 不能直接选，必须先解压；两种回归方式讲清楚 */}
      <section className="assets-migrate" id="assets-migrate-guide">
        <h3>
          导入导出的素材
          <span className="assets-en">Move assets between computers</span>
        </h3>
        <ol className="assets-migrate__steps">
          <li>
            <strong>1. 导出</strong>：点右上角「一键导出当前素材」，得到一个 zip 压缩包
            （Windows / macOS 都能打开）。
          </li>
          <li>
            <strong>2. 解压</strong>：先把 zip 解压成一张张图片；导入入口只接收图片文件，
            <strong>不能直接选择 zip</strong>。
          </li>
          <li>
            <strong>3. 导入（二选一）</strong>：
            <ul>
              <li>
                <strong>保留原文件名（推荐）</strong>：点「打开目录」，把解压后的图片直接放进
                <code>pet-assets</code> 文件夹——<code>happy.png</code> / <code>happy_001.png</code>
                会保持原名，放图即生效，不用重启。
              </li>
              <li>
                <strong>走应用导入</strong>：回到本页点「选择图片」批量导入，或在每个状态行点
                「上传」；系统会自动整理成英文命名，已有同名素材时序号会顺延。
              </li>
            </ul>
          </li>
        </ol>
        <p className="assets-migrate__en">
          Export → unzip → either copy the images into the pet-assets folder (file names preserved),
          or use “Choose images / Upload” above to import them through the app.
        </p>
      </section>

      <section className="assets-import">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".png,.jpg,.jpeg,.gif,.webp,.svg"
          className="assets-import__input"
          onChange={event => {
            onFilesPicked(event.target.files);
            // 清空 value：否则再次选同一个文件不会触发 change
            event.target.value = "";
          }}
        />
        <button id="assets-pick-button" className="assets-import__pick" onClick={() => pickFiles(null)} disabled={busy}>
          选择图片 / Choose images
        </button>
        <span className="assets-import__hint">PNG · JPG · GIF · WEBP · SVG，单张 ≤ 16MB</span>
      </section>

      {pending.length > 0 && (
        <section className="assets-pending">
          <div className="assets-pending__head">
            <strong>待导入 {pending.length} 张</strong>
            <button className="assets-link" onClick={() => setPending([])} disabled={busy}>
              清空
            </button>
          </div>
          {sequenceStates.length > 0 && (
            <p className="assets-pending__sequence">
              {t("assets.sequence", {
                states: sequenceStates
                  .map(state => (locale === "en" ? STATE_DOCS.find(doc => doc.state === state)?.en : STATE_DOCS.find(doc => doc.state === state)?.zh) ?? state)
                  .join(locale === "en" ? ", " : "、"),
              })}
            </p>
          )}
          <ul className="assets-pending__list">
            {pending.map((item, index) => (
              <li key={item.id} className="assets-pending__item">
                <div className="assets-pending__names">
                  <span className="assets-pending__from" title={item.from}>
                    {item.from}
                  </span>
                  <span className="assets-pending__arrow">→</span>
                  <code className="assets-pending__to">{planned[index]}</code>
                  {item.frame !== null && (
                    <span className="assets-pending__frame">帧 {String(item.frame).padStart(3, "0")}</span>
                  )}
                </div>
                <select
                  value={item.state}
                  onChange={event =>
                    setPending(prev =>
                      prev.map(entry =>
                        entry.id === item.id ? { ...entry, state: event.target.value as PetState } : entry,
                      ),
                    )
                  }
                  disabled={busy}
                >
                  {STATE_DOCS.map(doc => (
                    <option key={doc.state} value={doc.state}>
                      {doc.zh} · {doc.en}
                    </option>
                  ))}
                </select>
                <button
                  className="assets-pending__remove"
                  onClick={() => setPending(prev => prev.filter(entry => entry.id !== item.id))}
                  disabled={busy}
                  aria-label={t("assets.remove", { name: item.from })}
                >
                  ×
                </button>
                {!item.guessed && (
                  <p className="assets-pending__note">没从文件名认出状态，先按「待机」放，请手动选一个。</p>
                )}
              </li>
            ))}
          </ul>
          <button className="assets-import__go" onClick={() => void importAll()} disabled={busy}>
            {busy ? t("assets.importing") : t("assets.importN", { count: pending.length })}
          </button>
        </section>
      )}

      {notice && (
        <p className={`assets-notice assets-notice--${notice.tone}`} role="status">
          {notice.text}
        </p>
      )}

      <section className="assets-states">
        <h3>
          每个状态代表什么
          <span className="assets-en">What each state means</span>
        </h3>
        <p className="assets-lead">文件名用左侧的英文代码；中文名也可以，导入时会自动翻成英文。</p>
        <ul className="assets-states__list">
          {STATE_DOCS.map(doc => {
            const baseName = `${doc.state}.png`;
            const frameName = `${doc.state}_001.png`;
            return (
            <li key={doc.state} className="assets-state">
              <div className="assets-state__title">
                <code className="assets-state__code">{doc.state}</code>
                <strong>{doc.zh}</strong>
                <span className="assets-state__en">{doc.en}</span>
                <span className="assets-state__count">
                  {counts[doc.state] ? t("assets.count", { count: counts[doc.state] }) : t("assets.builtin")}
                </span>
                {/* 每状态独立上传（v0.23.0）：直接为该状态选图，免去通用入口的手动归位 */}
                <button
                  id={`assets-upload-${doc.state}`}
                  className="assets-state__upload"
                  onClick={() => pickFiles(doc.state)}
                >
                  {t("assets.upload")}
                </button>
              </div>
              {/* 点击复制命名（v0.23.0）：基础名与帧序列名各一枚，方便用户给自有素材改名 */}
              <div className="assets-state__names">
                <button
                  className={`assets-state__name${copiedName === baseName ? " assets-state__name--copied" : ""}`}
                  onClick={() => copyName(baseName)}
                  aria-label={t("assets.copyName", { name: baseName })}
                  title={t("assets.copyName", { name: baseName })}
                >
                  {copiedName === baseName ? t("assets.copied") : baseName}
                </button>
                <button
                  className={`assets-state__name${copiedName === frameName ? " assets-state__name--copied" : ""}`}
                  onClick={() => copyName(frameName)}
                  aria-label={t("assets.copyName", { name: frameName })}
                  title={t("assets.copyName", { name: frameName })}
                >
                  {copiedName === frameName ? t("assets.copied") : frameName}
                </button>
              </div>
              {(userPaths[doc.state] ?? []).length > 0 && (
                <div className="assets-state__thumbs">
                  {(userPaths[doc.state] ?? []).map(path => {
                    const name = fileNameOf(path);
                    return (
                      <div key={path} className="assets-thumb">
                        <img className="assets-thumb__img" src={convertFileSrc(path)} alt={name} loading="lazy" draggable={false} />
                        {pendingDelete === path ? (
                          <button
                            className="assets-thumb__del assets-thumb__del--confirm"
                            disabled={deleting}
                            onClick={() => removeAsset(path)}
                          >
                            {deleting ? "…" : t("assets.confirmDelete")}
                          </button>
                        ) : (
                          <button
                            className="assets-thumb__del"
                            onClick={() => setPendingDelete(path)}
                            aria-label={t("assets.delete") + " " + name}
                            title={t("assets.delete")}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="assets-state__when">{doc.zhWhen}</p>
              <p className="assets-state__when-en">{doc.enWhen}</p>
            </li>
            );
          })}
        </ul>
      </section>

      <p className="assets-foot">
        尺寸建议：竖构图、底部对齐、透明背景（220×260 窗口里约 200×240 显示区）。
        <br />
        Recommended: portrait, bottom-aligned, transparent background (~200×240 inside a 220×260 window).
      </p>
    </div>
  );
}
