import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appDataDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  STATE_DOCS,
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
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [existing, setExisting] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  /** 读一次用户目录：文件名用于规划变体序号，计数用于状态卡片上的"已有 N 张" */
  const refresh = useCallback(() => {
    void listUserAssets().then(map => {
      const names = Object.values(map).flat().map(fileNameOf);
      setExisting(names);
      setCounts(Object.fromEntries(Object.entries(map).map(([state, paths]) => [state, paths.length])));
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** 选文件：只做识别与规划，不写盘（写盘在「导入」里，用户先确认状态） */
  const onFilesPicked = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return;
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
        state: guessedState ?? "idle",
        guessed: guessedState !== null,
        frame: frameOfFileName(file.name),
      });
    }
    setPending(prev => [...prev, ...accepted]);
    setNotice(
      rejected.length > 0
        ? {
            tone: "error",
            text: `已忽略 ${rejected.length} 个不支持的文件：${rejected.slice(0, 3).join("、")}${rejected.length > 3 ? "…" : ""}（只支持 PNG / JPG / GIF / WEBP / SVG）`,
          }
        : null,
    );
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
        ? { tone: "ok", text: `已导入 ${saved.length} 张：${saved.slice(0, 4).join("、")}${saved.length > 4 ? "…" : ""}。放图即生效，不用重启。` }
        : { tone: "error", text: `成功 ${saved.length} 张，失败 ${failed.length} 张：${failed.slice(0, 2).join("；")}` },
    );
  }, [pending, busy, refresh]);

  const openFolder = useCallback(async () => {
    try {
      const dir = await join(await appDataDir(), "pet-assets");
      await revealItemInDir(dir);
    } catch {
      try {
        await revealItemInDir(await appDataDir());
      } catch {
        setNotice({ tone: "error", text: "没能打开目录，可在设置 → 关于 里打开数据目录。" });
      }
    }
  }, []);

  return (
    <div className="assets-page">
      <header className="assets-head">
        <h2>
          宠物素材
          <span className="assets-en">Pet assets</span>
        </h2>
        <button className="assets-link" onClick={() => void openFolder()}>
          打开目录 / Open folder
        </button>
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
        <button className="assets-import__pick" onClick={() => inputRef.current?.click()} disabled={busy}>
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
              检测到帧序列：{sequenceStates.map(state => STATE_DOCS.find(doc => doc.state === state)?.zh ?? state).join("、")}
              {" "}会按 001 / 002 / … 的顺序循环播放。同一帧重新导入会覆盖那一帧，不会打乱顺序。
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
                  aria-label={`移除 ${item.from}`}
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
            {busy ? "导入中… / Importing…" : `导入这 ${pending.length} 张 / Import ${pending.length}`}
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
          {STATE_DOCS.map(doc => (
            <li key={doc.state} className="assets-state">
              <div className="assets-state__title">
                <code className="assets-state__code">{doc.state}</code>
                <strong>{doc.zh}</strong>
                <span className="assets-state__en">{doc.en}</span>
                <span className="assets-state__count">
                  {counts[doc.state] ? `${counts[doc.state]} 张` : "内置图"}
                </span>
              </div>
              <p className="assets-state__when">{doc.zhWhen}</p>
              <p className="assets-state__when-en">{doc.enWhen}</p>
            </li>
          ))}
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
