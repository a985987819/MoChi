import { useCallback, useEffect, useState } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { appDataDir } from "@tauri-apps/api/path";
import { AppUpdatesSection } from "./AppUpdatesSection";
import { createProvider, PRESETS, getPreset } from "@/agent/providers";
import type { ProviderError } from "@/agent/providers";
import { memoryService, type MemoryItem } from "@/agent/memory/long-term";
import { historyStore } from "@/agent/memory/history-store";
import { sendStateEvent, STATE_EVENTS } from "@/shared/events";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { listen } from "@tauri-apps/api/event";
import {
  loadSettings,
  saveSettings,
  queueSettingsSave,
  flushSettingsSave,
  type AppSettings,
} from "@/services/settings";

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
  const [test, setTest] = useState<TestState>({ phase: "idle" });
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  // 设置面板卸载（切 Tab / 关窗）时冲刷防抖：最后一次输入不丢（P0-02）
  useEffect(() => () => flushSettingsSave(), []);

  /** 统一写盘出口：失败打印不含 Key 的可见提示，用户可保留当前表单直接重试。 */
  const persist = useCallback((next: AppSettings) => {
    void saveSettings(next).then(() => setSaveError("")).catch(() => {
      // 失败也不能打印包含 Key 的整个配置。
      setSaveError("设置保存失败，请检查磁盘后重试");
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

  if (!settings) return <div className="settings-panel">加载中…</div>;

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

      <MemoriesSection />

      <OnboardingSection update={update} />

      <DangerZone />

      <AboutSection />

      <p className="settings-note settings-note--foot">
        Key 保存在本机应用数据目录（settings.json），不上传任何服务器。
      </p>
    </div>
  );
}

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
 * 开机自启（P1-14）：默认关——不默认自启是桌宠软件的底线。
 * 设置是事实源；Rust 收事件后改系统自启项（Win 注册表 Run / mac LaunchAgent）。
 * 开启时说明会"开机后在托盘待命"，管理预期。
 */
function AutostartSection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const toggle = useCallback(
    (enabled: boolean) => {
      update({ autostartEnabled: enabled });
      void sendStateEvent(STATE_EVENTS.autostartChanged, { enabled });
    },
    [update],
  );

  return (
    <div className="settings-autostart">
      <span className="settings-field-label">开机自启</span>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.autostartEnabled}
          onChange={e => toggle(e.target.checked)}
        />
        <span>开机后自动运行（在托盘待命，不弹窗）</span>
      </label>
      <p className="settings-note">关闭这个开关就会恢复；也可以随时在任务管理器的「启动应用」里管理。</p>
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
  const [items, setItems] = useState<MemoryItem[]>([]);

  useEffect(() => {
    void memoryService.ready.then(() => void memoryService.list().then(setItems));
  }, []);

  const remove = useCallback((id: number) => {
    void memoryService.remove(id).then(() => void memoryService.list().then(setItems));
  }, []);

  return (
    <div className="settings-memories">
      <span className="settings-field-label">长期记忆（{items.length}）</span>
      {items.length === 0 && <p className="settings-note">还没有。对话里说"记住我喜欢低糖饮食"试试。</p>}
      {items.map(m => (
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
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");

  useEffect(() => {
    void getVersion().then(setVersion);
    void appDataDir().then(setDataDir);
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
      <div className="settings-about__row">
        <button className="settings-ghost-btn" onClick={copyDiagnostics}>
          {copyState === "ok" ? "已复制 ✓" : copyState === "fail" ? "复制失败，请手动截图" : "复制诊断信息"}
        </button>
        <button className="settings-ghost-btn" onClick={revealDataDir}>
          打开数据目录
        </button>
      </div>
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
