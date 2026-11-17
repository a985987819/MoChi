import { useCallback, useEffect, useState } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { appDataDir } from "@tauri-apps/api/path";
import { AppUpdatesSection } from "./AppUpdatesSection";
import { createProvider, PRESETS, getPreset } from "@/agent/providers";
import type { ProviderError } from "@/agent/providers";
import { memoryService, type MemoryItem } from "@/agent/memory/long-term";
import {
  applyAutostart,
  describeAutostart,
  readSystemAutostart,
  type AutostartSystemState,
} from "@/services/autostart";
import { historyStore } from "@/agent/memory/history-store";
import { sendStateEvent, STATE_EVENTS } from "@/shared/events";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { listen } from "@tauri-apps/api/event";
import { Loading, SkeletonLines } from "@/shared/components/Loading";
import {
  loadSettings,
  saveSettings,
  queueSettingsSave,
  flushSettingsSave,
  type AppSettings,
} from "@/services/settings";
import { listTtsVoices, speak, subscribeVoices } from "@/services/tts";
import { logError } from "@/services/log";
import type { LocaleSetting, ThemeMode } from "@/services/settings";
import { useT } from "@/shared/i18n/react";
import { backupsDir, exportBackup, formatBytes, importBackup, listBackups, type BackupInfo } from "@/services/backup";

/**
 * 设置 Tab —— v0.3.0：提供商/Key/模型 + 连通性测试。
 *
 * 交互设计：
 * - 每提供商独立 Key/模型桶（切提供商不丢配置，settings.ts 结构注释）；
 * - 所有更改**顺序写盘**（v0.8.2：saveSettings 串行 + 显式 store.save）——失败时
 *   给出可重试反馈（saveError 横幅），不用 autoSave 的"假成功"；
 * - 离散控件（下拉/开关）即时落盘；字符级输入（Key/模型名/数字）走 350ms 防抖
 *   （P0-02：否则输一个字符广播一次 settingsChanged，站立计时被反复重排），
 *   blur 与面板卸载时冲刷（flushSettingsSave），最后一次输入不丢；
 * - 连通性测试：用当前表单值现场建 Provider，发 ping，首个事件定成败（10s 超时）；
 *   成功显示首字延迟——这是流式体验最敏感的指标。
 */

type TestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "ok"; firstTokenMs: number }
  | { phase: "fail"; error: ProviderError };

export function SettingsTab() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [test, setTest] = useState<TestState>({ phase: "idle" });
  const [saveError, setSaveError] = useState("");

  // 加载失败不再"永远转圈"：给出重试入口（store 暂时不可读不该让设置页变砖）。
  const reload = useCallback(() => {
    setLoadError(false);
    void loadSettings().then(setSettings).catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // 设置面板卸载（切 Tab / 关窗）时冲刷防抖：最后一次输入不丢（P0-02）
  useEffect(() => () => flushSettingsSave(), []);

  /** 统一写盘出口：失败打印不含 Key 的可见提示，用户可保留当前表单直接重试。 */
  const persist = useCallback((next: AppSettings) => {
    void saveSettings(next).then(() => setSaveError("")).catch(() => {
      // 失败也不能打印包含 Key 的整个配置。
      setSaveError("设置保存失败，请检查磁盘后重试");
      logError("settings", "设置保存失败（磁盘不可写或 store 异常）");
    });
  }, []);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      persist(next); // 离散控件（下拉/开关）：单次事件，直存
      return next;
    });
  }, [persist]);

  /** 字符级输入（数字输入框）专用：走防抖，blur 时冲刷 */
  const updateDebounced = useCallback((patch: Partial<AppSettings>) => {
    setSettings(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      queueSettingsSave(next);
      return next;
    });
  }, []);

  const updateKey = useCallback(
    (providerId: string, key: string) => {
      setSettings(prev => {
        if (!prev) return prev;
        const next = { ...prev, apiKeys: { ...prev.apiKeys, [providerId]: key } };
        queueSettingsSave(next); // Key 逐字符输入：防抖（P0-02）
        return next;
      });
    },
    [],
  );

  const updateModel = useCallback((providerId: string, model: string, debounce = false) => {
    setSettings(prev => {
      if (!prev) return prev;
      const next = { ...prev, models: { ...prev.models, [providerId]: model } };
      if (debounce) queueSettingsSave(next);
      else persist(next);
      return next;
    });
  }, [persist]);

  const runTest = useCallback(async () => {
    if (!settings) return;
    setTest({ phase: "testing" });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    const started = performance.now();
    try {
      const provider = createProvider(settings);
      for await (const ev of provider.chatStream(
        { messages: [{ role: "user", content: "ping" }] },
        controller.signal,
      )) {
        if (ev.type === "text-delta") {
          setTest({ phase: "ok", firstTokenMs: Math.round(performance.now() - started) });
          controller.abort(); // 首字到达即成功，不必等整条回完
          break;
        }
        if (ev.type === "error") {
          setTest({ phase: "fail", error: ev.error });
          break;
        }
      }
      setTest(prev => (prev.phase === "testing" ? { phase: "fail", error: { kind: "network", message: "无响应" } } : prev));
    } catch (e) {
      setTest({ phase: "fail", error: { kind: "network", message: String(e) } });
    } finally {
      window.clearTimeout(timeout);
    }
  }, [settings]);

  if (loadError) {
    return (
      <div className="settings-panel">
        <p role="alert">设置读取失败，可能是磁盘或应用数据目录暂时不可用。</p>
        <p className="settings-note"><button className="settings-link" onClick={reload}>重试加载</button></p>
      </div>
    );
  }
  if (!settings) {
    // 已知形状的面板用骨架行占位：比单点 spinner 少一次高度跳变
    return (
      <div className="settings-panel">
        <SkeletonLines widths={[0.4, 0.9, 0.9, 0.35, 0.6]} rows={5} />
        <SkeletonLines widths={[0.45, 0.9]} rows={2} />
      </div>
    );
  }

  const preset = getPreset(settings.providerId);
  const apiKey = settings.apiKeys[settings.providerId] ?? "";
  const model = settings.models[settings.providerId] ?? preset?.defaultModel ?? "";

  return (
    <div className="settings-panel">
      {saveError && <p role="alert">{saveError} <button onClick={() => persist(settings)}>重试保存</button></p>}

      <AppUpdatesSection />

      <label className="settings-field">
        <span>ta自称</span>
        <input
          type="text"
          value={settings.petSelfName}
          onChange={e => update({ petSelfName: e.target.value })}
          placeholder="麻薯"
        />
      </label>
      <label className="settings-field">
        <span>ta对我的称呼</span>
        <input
          type="text"
          value={settings.userNickname}
          onChange={e => update({ userNickname: e.target.value })}
          placeholder="人"
        />
      </label>
      <p className="settings-note">保存后从下一轮对话生效；留空时分别使用「麻薯」和「人」。</p>

      <label className="settings-field">
        <span>提供商</span>
        <select value={settings.providerId} onChange={e => update({ providerId: e.target.value })}>
          {PRESETS.map(p => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      {preset?.notes && <p className="settings-note">{preset.notes}</p>}

      {preset?.requiresKey && (
        <label className="settings-field">
          <span>API Key</span>
          <input
            type="password"
            value={apiKey}
            onChange={e => updateKey(preset.id, e.target.value)}
            onBlur={flushSettingsSave}
            placeholder={apiKey ? "已保存（输入即覆盖）" : "sk-…"}
            autoComplete="off"
          />
        </label>
      )}
      {preset?.keysUrl && <KeysUrlNote url={preset.keysUrl} />}

      <label className="settings-field">
        <span>模型</span>
        {preset && preset.models.length > 0 ? (
          <select value={model} onChange={e => updateModel(preset.id, e.target.value)}>
            {preset.models.map(m => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          // Ollama 等本机模型动态变化：允许自由填写（datalist 给提示不强制）
          <>
            <input
              value={model}
              onChange={e => preset && updateModel(preset.id, e.target.value, true)}
              onBlur={flushSettingsSave}
              placeholder="模型名（如 qwen2.5:7b）"
            />
            <datalist id="model-suggestions">
              {preset?.models.map(m => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </>
        )}
      </label>

      <div className="settings-test">
        <button onClick={() => void runTest()} disabled={test.phase === "testing"}>
          {test.phase === "testing" ? "测试中…" : "测试连通性"}
        </button>
        {test.phase === "ok" && <span className="settings-test__ok">✓ 连通（首字 {test.firstTokenMs}ms）</span>}
        {test.phase === "fail" && (
          <span className="settings-test__fail">
            ✗ [{test.error.kind}] {test.error.message}
          </span>
        )}
      </div>

      <TimerConfigSection settings={settings} update={update} updateDebounced={updateDebounced} />

      <PetSizeSection settings={settings} update={update} />

      <ShortcutSection settings={settings} update={update} />

      <AutostartSection settings={settings} update={update} />

      <SoundSection settings={settings} update={update} updateDebounced={updateDebounced} />

      <ThemeSection settings={settings} update={update} />

      <LanguageSection settings={settings} update={update} />

      <TtsSection settings={settings} update={update} updateDebounced={updateDebounced} />

      <GameModeSection settings={settings} update={update} />

      <MemoriesSection />

      <OnboardingSection update={update} />

      <BackupsSection />

      <DangerZone />

      <AboutSection />

      <p className="settings-note settings-note--foot">
        Key 保存在本机应用数据目录（settings.json），不上传任何服务器。
      </p>
    </div>
  );
}

/** 免打扰时段可选整点（0~23）：分钟级精度对"别半夜吵我"没有意义，整点足够 */
const QUIET_HOURS = Array.from({ length: 24 }, (_, index) => index);

/**
 * 计时配置 —— v0.7.0：站立间隔/番茄钟时长/通知开关。
 * 数字输入框走防抖（P0-02）：onChange 每敲一个键 queue 一次、blur 冲刷一次，
 * 不再「输 30 就重排两次站立计时」。数值边界由 settings.normalize 夹紧
 * （1~120 等）。通知开关是离散控件，走 update 直存 + 广播。
 */
function TimerConfigSection({
  settings,
  update,
  updateDebounced,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  updateDebounced: (patch: Partial<AppSettings>) => void;
}) {
  return (
    <div className="settings-timers">
      <span className="settings-field-label">计时配置</span>
      <label className="settings-field">
        <span>站立提醒间隔（分钟，1~120）</span>
        <input
          type="number"
          min={1}
          max={120}
          value={settings.standupIntervalMin}
          onChange={e => updateDebounced({ standupIntervalMin: Number(e.target.value) })}
          onBlur={flushSettingsSave}
        />
      </label>
      <div className="settings-row">
        <label className="settings-field">
          <span>番茄钟专注（分钟）</span>
          <input
            type="number"
            min={5}
            max={90}
            value={settings.pomodoroFocusMin}
            onChange={e => updateDebounced({ pomodoroFocusMin: Number(e.target.value) })}
            onBlur={flushSettingsSave}
          />
        </label>
        <label className="settings-field">
          <span>休息（分钟）</span>
          <input
            type="number"
            min={1}
            max={30}
            value={settings.pomodoroBreakMin}
            onChange={e => updateDebounced({ pomodoroBreakMin: Number(e.target.value) })}
            onBlur={flushSettingsSave}
          />
        </label>
      </div>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.notificationsEnabled}
          onChange={e => update({ notificationsEnabled: e.target.checked })}
        />
        <span>启用系统通知（站立提醒 / 番茄钟 / 到点提醒）</span>
      </label>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.quietHoursEnabled}
          onChange={e => update({ quietHoursEnabled: e.target.checked })}
        />
        <span>免打扰时段（只静默站立提醒）</span>
      </label>
      {settings.quietHoursEnabled && (
        <>
          <div className="settings-field">
            <span>时段（跨午夜会自动顺延到次日）</span>
            <div className="settings-hours">
              <select
                value={settings.quietStartHour}
                onChange={e => update({ quietStartHour: Number(e.target.value) })}
                aria-label="免打扰开始时间"
              >
                {QUIET_HOURS.map(hour => (
                  <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>
                ))}
              </select>
              <span className="settings-hours__sep">到</span>
              <select
                value={settings.quietEndHour}
                onChange={e => update({ quietEndHour: Number(e.target.value) })}
                aria-label="免打扰结束时间"
              >
                {QUIET_HOURS.map(hour => (
                  <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>
                ))}
              </select>
            </div>
          </div>
          <p className="settings-note">
            时段内不弹站立提醒，结束后补一次；自定义提醒和番茄钟照常响——那是你定的时间。
          </p>
        </>
      )}
      <NotificationPermissionHint />
    </div>
  );
}

/**
 * 通知权限状态（P0-03）：让用户知道到点提醒到底会不会有系统通知。
 * 插件只暴露"是否已授权"布尔值（没有"被拒绝/未询问"之分）——未授权时给出
 * 两条路：页面内重新请求，或去系统设置开（权限被永久拒绝时页面内请求无效）。
 * 查询中渲染 null，避免闪一下"未授权"。
 */
function NotificationPermissionHint() {
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    void isPermissionGranted()
      .then(setGranted)
      .catch(() => setGranted(false));
  }, []);

  const request = useCallback(() => {
    void requestPermission().then(state => setGranted(state === "granted"));
  }, []);

  if (granted === null) return null;
  if (granted) return <p className="settings-note">系统通知权限：已授权 ✓</p>;
  return (
    <div>
      <p className="settings-note">
        系统通知权限：未授权，到点提醒只弹宠物提醒窗、没有系统通知。
      </p>
      <p className="settings-note">
        <button className="settings-link" onClick={request}>请求权限</button>
        ，或到系统设置开启（Windows：设置 → 系统 → 通知；macOS：系统设置 → 通知 → Mochi）。
      </p>
    </div>
  );
}

/**
 * 全局快捷键（P1-13）：键位 Rust 侧写死 Ctrl/Cmd+Shift+M（v1 不做自定义），
 * 这里只有开关。注册结果经 state://shortcut-state 回传——键位被其他软件
 * 占用时提示（静默降级：聊天窗本身不受影响）。
 */
function ShortcutSection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const [registered, setRegistered] = useState<boolean | null>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    void listen<{ enabled: boolean; registered: boolean }>(STATE_EVENTS.shortcutState, e => {
      setRegistered(e.payload?.registered ?? null);
    }).then(unlisten => {
      off = unlisten;
    });
    return () => off?.();
  }, []);

  const toggle = useCallback(
    (enabled: boolean) => {
      update({ shortcutEnabled: enabled });
      void sendStateEvent(STATE_EVENTS.shortcutChanged, { enabled });
    },
    [update],
  );

  return (
    <div className="settings-shortcut">
      <span className="settings-field-label">全局快捷键</span>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.shortcutEnabled}
          onChange={e => toggle(e.target.checked)}
        />
        <span>Ctrl/Cmd + Shift + M 打开聊天窗</span>
      </label>
      {settings.shortcutEnabled && registered === false && (
        <p className="settings-note">快捷键被其他软件占用了，功能不受影响；关掉占用方后重新打开开关即可。</p>
      )}
    </div>
  );
}

/**
 * 开机自动打开（v0.9.1 由 P1-14「开机自启」升级而来，**默认关**——不默认自启是底线）。
 *
 * 语义：开机后麻薯自己出现在桌面上（位置沿用上次拖到的地方，不弹聊天窗）。
 *
 * 三层事实，缺一层就会骗人：
 * ① 设置值（settings.autostartEnabled）——用户的意图，落 settings.json；
 * ② 系统启动项——真正决定开机是否启动的东西，只有 Rust 能写/读；
 * ③ 回执（state://autostart-state）——Rust 执行后用 is_enabled() 读回的真值。
 * 本组件把 ①③ 对齐后交给 describeAutostart 说人话：生效/被拦截/系统里还留着。
 * 没有 ③ 时，开关一旦被安全软件回滚就是"开关开着、开机不启动"的假成功。
 */
function AutostartSection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const [system, setSystem] = useState<AutostartSystemState | null>(null);
  const [applying, setApplying] = useState(false);

  // 挂载时读一次系统真值（校正"设置说开着、系统里没有"的错位），并订阅回执
  useEffect(() => {
    void readSystemAutostart().then(enabled => {
      if (enabled !== null) setSystem(prev => ({ enabled, ok: prev?.ok ?? true, error: prev?.error }));
    });
    const unlisten = listen<AutostartSystemState>(STATE_EVENTS.autostartState, e => {
      setSystem(e.payload);
      setApplying(false);
    });
    return () => {
      void unlisten.then(off => off());
    };
  }, []);

  const toggle = useCallback(
    (enabled: boolean) => {
      update({ autostartEnabled: enabled });
      setApplying(true);
      void applyAutostart(enabled).finally(() => setApplying(false));
    },
    [update],
  );

  /** 重新应用 = 无视当前开关值，把设置值再写一次系统（用于自愈/清理残留） */
  const reapply = useCallback(() => {
    setApplying(true);
    void applyAutostart(settings.autostartEnabled).finally(() => setApplying(false));
  }, [settings.autostartEnabled]);

  const hint = describeAutostart(settings.autostartEnabled, system);

  return (
    <div className="settings-autostart">
      <span className="settings-field-label">开机自动打开</span>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.autostartEnabled}
          onChange={e => toggle(e.target.checked)}
        />
        <span>开机后自动打开麻薯（出现在桌面右下角，不弹聊天窗）</span>
      </label>

      {hint.tone !== "none" && (
        <p className={`settings-note settings-note--${hint.tone}`}>
          {hint.text}
          {hint.tone === "warn" && (
            <button className="settings-link" onClick={reapply} disabled={applying}>
              {applying ? "正在应用…" : "重新应用"}
            </button>
          )}
        </p>
      )}

      <p className="settings-note">
        {settings.autostartEnabled
          ? "关掉这个开关就会取消；也可以在任务管理器的「启动应用」里管理。"
          : "不开也能用：随时双击桌面上的麻薯，或用托盘图标打开。"}
      </p>
    </div>
  );
}

/**
 * 声音（v0.12.0）：点击反馈音 + 提醒音，全部用 Web Audio 合成，仓库里没有音频文件。
 *
 * 为什么默认开：声音是"不看屏幕也知道发生了什么"的唯一通道——桌宠的提醒本来就
 * 假设用户没盯着它。关掉开关会连 `AudioContext` 一起释放，而不是留着空转。
 * 音量是相对值（乘在每个音符的基准增益上），0% 等价静音。
 */
function SoundSection({
  settings,
  update,
  updateDebounced,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  updateDebounced: (patch: Partial<AppSettings>) => void;
}) {
  return (
    <div className="settings-sound">
      <span className="settings-field-label">声音</span>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.soundEnabled}
          onChange={e => update({ soundEnabled: e.target.checked })}
        />
        <span>点击与提醒音效（合成音，可随时关掉）</span>
      </label>
      {settings.soundEnabled && (
        <label className="settings-field">
          <span>音量 {settings.soundVolume}%</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={settings.soundVolume}
            onChange={e => updateDebounced({ soundVolume: Number(e.target.value) })}
            onBlur={flushSettingsSave}
          />
        </label>
      )}
      <p className="settings-note">
        免打扰时段内提醒不出声；点击音仍然保留——那是你主动点的，静默它只会让人以为卡住了。
      </p>
    </div>
  );
}

/**
 * 主题（v0.18.0 P2-03A）：跟随系统 / 浅色 / 深色。
 *
 * 离散控件直存（update）；每个 WebView 各自监听 settingsChanged 应用 data-theme
 * （shared/theme.ts）——主题是外观，切换即时生效、无需重启。深色是**暖棕灰**
 * 底不是反色（theme.css 取舍注释）；素材图片任何主题下都不加滤镜。
 */
function ThemeSection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const options: Array<{ value: ThemeMode; label: string }> = [
    { value: "system", label: "跟随系统" },
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" },
  ];
  return (
    <div className="settings-sound">
      <span className="settings-field-label">主题</span>
      <div className="settings-segment">
        {options.map(option => (
          <button
            key={option.value}
            className={settings.themeMode === option.value ? "settings-segment__btn settings-segment__btn--active" : "settings-segment__btn"}
            onClick={() => update({ themeMode: option.value })}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="settings-note">宠物形象与素材不受主题影响；提醒弹窗、右键菜单会一起切换。</p>
    </div>
  );
}

/**
 * 语言（v0.19.0 P2-03B）：跟随系统 / 简体中文 / English。
 * 本分区自身走 t() —— 它是 i18n 的示范位；切换后 useSyncExternalStore 立即
 * 重渲染所有已迁移界面（任务单验收：不需要重启）。
 */
function LanguageSection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const { t } = useT();
  const options: Array<{ value: LocaleSetting; label: string }> = [
    { value: "system", label: t("locale.system") },
    { value: "zh-CN", label: t("locale.zhCN") },
    { value: "en", label: t("locale.en") },
  ];
  return (
    <div className="settings-sound">
      <span className="settings-field-label">{t("settings.language")}</span>
      <div className="settings-segment">
        {options.map(option => (
          <button
            key={option.value}
            className={settings.locale === option.value ? "settings-segment__btn settings-segment__btn--active" : "settings-segment__btn"}
            onClick={() => update({ locale: option.value })}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="settings-note">{t("settings.languageNote")}</p>
    </div>
  );
}

/**
 * 语音朗读（v0.15.0 P1-03）：Web Speech API 系统语音包（免费、离线、零 Key）。
 *
 * 为什么默认关（任务单要求写清）：音效是短促提示音，TTS 是把整段回复念出来——
 * 不问就把每轮对话念出声是打扰，所以默认关，让用户主动开。音色列表来自系统
 * （voiceschanged 异步到达，订阅刷新）；没有中文音色时如实提示"将使用系统默认"。
 * 「试听」直接调 speak：开关/免打扰的拦截逻辑对试听同样生效——关着开关点试听
 * 没有声音是**正确行为**，按钮在开关关闭时禁用。
 */
function TtsSection({
  settings,
  update,
  updateDebounced,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  updateDebounced: (patch: Partial<AppSettings>) => void;
}) {
  const [voices, setVoices] = useState(() => listTtsVoices());

  // 系统音色异步枚举（WebView2 首次 getVoices() 常为空）：voiceschanged 到达后刷新
  useEffect(() => subscribeVoices(() => setVoices(listTtsVoices())), []);

  const hasChineseVoice = voices.some(v => v.lang.toLowerCase().startsWith("zh"));
  const selectedVoiceExists = !settings.ttsVoiceName || voices.some(v => v.name === settings.ttsVoiceName);

  return (
    <div className="settings-sound">
      <span className="settings-field-label">语音朗读</span>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.ttsEnabled}
          onChange={e => update({ ttsEnabled: e.target.checked })}
        />
        <span>朗读麻薯的回复（系统语音，默认关）</span>
      </label>
      {settings.ttsEnabled && (
        <>
          <label className="settings-field">
            <span>语速 {settings.ttsRate.toFixed(1)}x</span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={settings.ttsRate}
              onChange={e => updateDebounced({ ttsRate: Number(e.target.value) })}
              onBlur={flushSettingsSave}
            />
          </label>
          <label className="settings-field">
            <span>音色</span>
            <select
              value={settings.ttsVoiceName}
              onChange={e => update({ ttsVoiceName: e.target.value })}
            >
              <option value="">自动（中文优先）</option>
              {voices.map(v => (
                <option key={v.name} value={v.name}>
                  {v.name}（{v.lang}）
                </option>
              ))}
            </select>
          </label>
          {voices.length > 0 && !hasChineseVoice && (
            <p className="settings-note">系统里没找到中文音色，会使用系统默认音色念中文。</p>
          )}
          {!selectedVoiceExists && (
            <p className="settings-note">之前选择的音色不在了（系统语音包变化），已回落到自动挑选。</p>
          )}
          <div className="settings-test">
            <button onClick={() => speak("你好，我是麻薯，这是朗读试听。")}>试听一句</button>
          </div>
        </>
      )}
      <p className="settings-note">
        新回复说完才朗读；发新消息、点一下麻薯或关掉聊天窗都会立刻停。免打扰时段内不朗读。
      </p>
    </div>
  );
}

/**
 * 游戏模式（v0.9.0 自迭代）：前台应用全屏覆盖显示器时自动隐藏麻薯，退出恢复。
 * 隐私边界（learning/08 §3 红线的兑现形态）：只读前台窗口的**矩形几何**判断
 * 是否全屏——不读应用名/标题/进程，不构成"推断用户在忙什么"；默认关。
 * 平台：Windows 全支持；macOS 暂无对应实现（无本机验证手段），开关禁用并说明。
 */
function GameModeSection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const isMac = /Mac/i.test(navigator.platform);
  const toggle = useCallback(
    (enabled: boolean) => {
      update({ gameModeEnabled: enabled });
      void sendStateEvent(STATE_EVENTS.gameModeChanged, { enabled });
    },
    [update],
  );

  return (
    <div className="settings-gamemode">
      <span className="settings-field-label">游戏模式</span>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.gameModeEnabled && !isMac}
          disabled={isMac}
          onChange={e => toggle(e.target.checked)}
        />
        <span>全屏应用（游戏/视频）时自动隐藏麻薯</span>
      </label>
      {isMac && <p className="settings-note">macOS 暂不支持此功能（已知限制），开关保持关闭。</p>}
      {!isMac && settings.gameModeEnabled && (
        <p className="settings-note">
          只检测前台窗口是否全屏（不看应用名和内容）；麻薯所在屏幕被全屏覆盖时隐藏，退出全屏恢复。
        </p>
      )}
      <p className="settings-note">默认关闭——任何形式的"看前台"都需要你明示开启。</p>
    </div>
  );
}

/**
 * 宠物大小（P1-15）：三档（0.8/1/1.2）。窗口尺寸由 Rust 改（右下角锚点 +
 * 屏内 clamp），宠物窗写 CSS 变量缩放形象——本组件只落盘 + 广播。
 */
function PetSizeSection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const change = useCallback(
    (scale: number) => {
      update({ petScale: scale });
      void sendStateEvent(STATE_EVENTS.petScaleChanged, { scale });
    },
    [update],
  );

  return (
    <div className="settings-petsize">
      <span className="settings-field-label">宠物大小</span>
      <label className="settings-field">
        <span>麻薯的个头</span>
        <select value={String(settings.petScale)} onChange={e => change(Number(e.target.value))}>
          <option value="0.8">小（0.8×）</option>
          <option value="1">标准</option>
          <option value="1.2">大（1.2×）</option>
        </select>
      </label>
    </div>
  );
}

/**
 * 记忆管理 —— learning/04 §5 隐私规范：用户对记忆有完全控制权（查看/删除）。
 * "记住我…"写入的事实在这里全部可见、可单条删除。
 */
function MemoriesSection() {
  const [items, setItems] = useState<MemoryItem[] | null>(null); // null=加载中（区别于"空"）
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    void memoryService.ready
      .then(() => memoryService.list())
      .then(setItems)
      .catch(() => setLoadError(true));
  }, []);

  const remove = useCallback((id: number) => {
    void memoryService.remove(id).then(() => void memoryService.list().then(setItems));
  }, []);

  return (
    <div className="settings-memories">
      <span className="settings-field-label">长期记忆（{items?.length ?? "…"}）</span>
      {items === null && !loadError && <Loading label="正在读取记忆…" />}
      {loadError && <p className="settings-note" role="alert">记忆读取失败（数据库暂不可用），功能重试稍后自动恢复。</p>}
      {items !== null && !loadError && items.length === 0 && <p className="settings-note">还没有。对话里说"记住我喜欢低糖饮食"试试。</p>}
      {items?.map(m => (
        <div key={m.id} className="settings-memory">
          <span className="settings-memory__fact">{m.fact}</span>
          <span className="settings-memory__src">{m.source === "agent" ? "自动" : "手动"}</span>
          <button onClick={() => remove(m.id)} aria-label="删除记忆">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * 使用指引 —— v0.9.0：把首次启动引导做成"可回看"。
 * 实现上不做单独的引导路由：onboardingDone 置回 false + 广播事件，
 * 聊天窗（ChatApp）用同一套 WelcomeGuide 覆盖层接住，避免两份文案漂移。
 */
function OnboardingSection({ update }: { update: (patch: Partial<AppSettings>) => void }) {
  const replay = useCallback(() => {
    update({ onboardingDone: false });
    void sendStateEvent(STATE_EVENTS.onboardingRequested);
  }, [update]);

  return (
    <div className="settings-help">
      <span className="settings-field-label">使用指引</span>
      <button className="settings-ghost-btn" onClick={replay}>
        重新显示新手引导
      </button>
    </div>
  );
}

/** 危险区：清空聊天历史（协议层 messages 表；待办/记忆不受影响） */
function DangerZone() {
  const clearHistory = useCallback(() => {
    if (!window.confirm("确定清空全部聊天历史？此操作不可恢复（待办与记忆保留）。")) return;
    void historyStore.clear().then(() => void sendStateEvent(STATE_EVENTS.historyCleared));
  }, []);

  return (
    <div className="settings-danger">
      <span className="settings-field-label">危险操作</span>
      <button onClick={clearHistory}>清空聊天历史</button>
    </div>
  );
}

/**
 * 关于 —— v0.9.0 P0-06：版本自报 + 数据目录入口。
 * 用户反馈问题时能自报版本号；诊断文本一键复制、可直接贴进 issue；
 * 数据目录打开后用户可自行备份 settings.json / mochi.db / pet-assets/。
 * 权限说明：getVersion / appDataDir 由 core:default（含 core:path:default）
 * 覆盖；revealItemInDir 在 opener:default 内——均无需新增 capability。
 * 剪贴板用 navigator.clipboard（WebView2 支持，零新依赖），失败给可见提示。
 */
function AboutSection() {
  const [version, setVersion] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [lastPanic, setLastPanic] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");

  useEffect(() => {
    void getVersion().then(setVersion);
    void appDataDir().then(setDataDir);
    // 上次崩溃摘要（v0.16.0）：无记录 = 最近没有崩溃，什么也不显示（不打扰）；
    // 读取失败静默——「关于」页不该因为排障通道挂掉而报错。
    void invoke<string | null>("get_last_panic")
      .then(summary => setLastPanic(summary ?? null))
      .catch(() => undefined);
  }, []);

  const copyDiagnostics = useCallback(() => {
    const text = `Mochi v${version}\n平台：${navigator.userAgent}\n数据目录：${dataDir}`;
    navigator.clipboard
      .writeText(text)
      .then(() => setCopyState("ok"))
      .catch(() => setCopyState("fail"));
  }, [version, dataDir]);

  useEffect(() => {
    if (copyState === "idle") return;
    const t = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(t);
  }, [copyState]);

  const revealDataDir = useCallback(() => {
    if (dataDir) void revealItemInDir(dataDir).catch(() => undefined);
  }, [dataDir]);

  return (
    <div className="settings-about">
      <span className="settings-field-label">关于</span>
      <p className="settings-note">Mochi v{version || "…"}</p>
      <p className="settings-note">数据目录：{dataDir || "…"}</p>
      {lastPanic && (
        <p className="settings-note settings-note--panic">
          上次崩溃记录（{dataDir ? `${dataDir}\\logs\\last-panic.txt` : "数据目录 logs/last-panic.txt"}）：
          {"\n"}
          {lastPanic}
        </p>
      )}
      <div className="settings-about__row">
        <button className="settings-ghost-btn" onClick={copyDiagnostics}>
          {copyState === "ok" ? "已复制 ✓" : copyState === "fail" ? "复制失败，请手动截图" : "复制诊断信息"}
        </button>
        <button className="settings-ghost-btn" onClick={revealDataDir}>
          打开数据目录
        </button>
      </div>
      <p className="settings-note">运行日志在数据目录的 logs\ 文件夹（按天一个文件，保留 7 天）。</p>
    </div>
  );
}

/**
 * 备份与恢复（v0.17.0 P2-02）：一键 zip（settings + mochi.db + pet-assets + manifest）
 * 到固定目录 {appData}/backups/，导入从备份列表选择。
 *
 * # 为什么没有文件选择对话框
 *
 * tauri-plugin-dialog 是为一次低频操作加插件 + capability（任务单明确要先确认），
 * 退化方案更收敛：导出到固定目录（reveal 一键可达），外部备份文件拖进 backups
 * 目录即可出现在列表里；导入路径只接受列表里的文件，Rust 侧再校验路径必须落在
 * 备份目录内——防 IPC 任意路径写。
 *
 * # 密钥说明（任务单验收要求写清）
 *
 * 导出默认**不含** API Key（备份文件容易被拷去网盘/U盘）；勾选「包含密钥」才会
 * 写入。pre-restore 自动备份恒含密钥——它是覆盖前的退路，退路不能比现场贫瘠。
 */
function BackupsSection() {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [listError, setListError] = useState("");
  const [includeKeys, setIncludeKeys] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportedPath, setExportedPath] = useState("");
  const [pendingImport, setPendingImport] = useState<BackupInfo | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [importError, setImportError] = useState("");
  const [dir, setDir] = useState("");

  const refresh = useCallback(() => {
    setListError("");
    void listBackups()
      .then(setBackups)
      .catch(() => setListError("备份列表读取失败，请稍后重试"));
  }, []);

  useEffect(() => {
    refresh();
    void backupsDir().then(setDir).catch(() => undefined);
  }, [refresh]);

  const runExport = useCallback(() => {
    setExporting(true);
    setExportedPath("");
    void exportBackup(includeKeys)
      .then(path => {
        setExportedPath(path);
        refresh();
      })
      .catch(e => setImportError(e instanceof Error ? e.message : String(e)))
      .finally(() => setExporting(false));
  }, [includeKeys, refresh]);

  const revealExport = useCallback(() => {
    if (exportedPath) void revealItemInDir(exportedPath).catch(() => undefined);
  }, [exportedPath]);

  const runImport = useCallback((backup: BackupInfo) => {
    setImporting(true);
    setImportError("");
    setImportMessage("");
    const path = dir ? `${dir}${dir.includes("\\") ? "\\" : "/"}${backup.name}` : "";
    void importBackup(path)
      .then(message => {
        setImportMessage(message);
        setPendingImport(null);
        refresh();
      })
      .catch(e => setImportError(e instanceof Error ? e.message : String(e)))
      .finally(() => setImporting(false));
  }, [dir, refresh]);

  return (
    <div className="settings-sound">
      <span className="settings-field-label">备份与恢复</span>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={includeKeys}
          onChange={e => setIncludeKeys(e.target.checked)}
        />
        <span>备份包含 API Key（默认不包含——备份文件可能被拷到网盘/U盘）</span>
      </label>
      <div className="settings-test">
        <button onClick={runExport} disabled={exporting}>
          {exporting ? "导出中…" : "导出备份"}
        </button>
        {exportedPath && (
          <>
            <span className="settings-test__ok">✓ 已导出</span>
            <button className="settings-ghost-btn" onClick={revealExport}>
              打开位置
            </button>
          </>
        )}
      </div>
      <p className="settings-note">
        备份内容：设置（{includeKeys ? "含" : "不含"}密钥）+ 数据库 + 素材，存到 {dir || "数据目录\\backups"}。
      </p>

      <span className="settings-field-label">从备份恢复</span>
      {listError && (
        <p className="rem-hint rem-hint--error" role="alert">
          {listError}
        </p>
      )}
      {backups !== null && backups.length === 0 && !listError && (
        <p className="rem-hint">还没有备份。导出一次，或把别的备份 zip 放进 backups 文件夹</p>
      )}
      {backups?.map(backup => (
        <div key={backup.name} className="settings-backup__row">
          <span className="settings-backup__name" title={backup.name}>
            {backup.name}
          </span>
          <span className="settings-backup__meta">
            {new Date(backup.modifiedMs).toLocaleString("zh-CN", {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
            · {formatBytes(backup.sizeBytes)}
          </span>
          {pendingImport?.name === backup.name ? (
            <span className="settings-backup__confirm">
              <button disabled={importing} onClick={() => runImport(backup)}>
                {importing ? "恢复中…" : "确认覆盖"}
              </button>
              <button disabled={importing} onClick={() => setPendingImport(null)}>
                取消
              </button>
            </span>
          ) : (
            <button onClick={() => setPendingImport(backup)}>导入</button>
          )}
        </div>
      ))}
      {pendingImport && (
        <p className="settings-note settings-note--panic">
          即将用「{pendingImport.name}」覆盖当前全部数据（会先自动备份现有数据）。确认无误再点「确认覆盖」。
        </p>
      )}
      {importMessage && <p className="settings-test__ok">✓ {importMessage}</p>}
      {importError && (
        <p className="rem-hint rem-hint--error" role="alert">
          {importError}
        </p>
      )}
    </div>
  );
}

/**
 * 申请 Key 的外链提示 —— v0.9.0 P0-01。
 * 为什么不用 <a href>：Tauri WebView 不会把外链导航交给系统浏览器（CSP 禁止
 * 导航到外部站点），点击毫无反应——必须走 opener 插件的 openUrl。
 * opener:default 权限已覆盖 http/https（capabilities/default.json），无需额外配置。
 * openUrl 失败时（无默认浏览器等）退化为纯文本，用户仍可手动复制访问。
 */
function KeysUrlNote({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);

  const open = useCallback(() => {
    void openUrl(url).catch(() => setFailed(true));
  }, [url]);

  if (failed) {
    return (
      <p className="settings-note">
        无法自动打开浏览器，请手动访问：{url}
      </p>
    );
  }
  return (
    <p className="settings-note">
      还没有 Key？<button className="settings-link" onClick={open}>{url}</button>
    </p>
  );
}
