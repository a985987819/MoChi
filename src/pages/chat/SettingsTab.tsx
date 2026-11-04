import { useCallback, useEffect, useState } from "react";
import { createProvider, PRESETS, getPreset } from "@/agent/providers";
import type { ProviderError } from "@/agent/providers";
import { memoryService, type MemoryItem } from "@/agent/memory/long-term";
import { historyStore } from "@/agent/memory/history-store";
import { sendStateEvent, STATE_EVENTS } from "@/shared/events";
import { loadSettings, saveSettings, type AppSettings } from "@/services/settings";

/**
 * 设置 Tab —— v0.3.0：提供商/Key/模型 + 连通性测试。
 *
 * 交互设计：
 * - 每提供商独立 Key/模型桶（切提供商不丢配置，settings.ts 结构注释）；
 * - 所有更改顺序写盘（应用服务显式 save）——失败时给出可重试反馈；
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

  const persist = useCallback((next: AppSettings) => {
    void saveSettings(next).then(() => setSaveError("")).catch(() => {
      // 失败也不能打印包含 Key 的整个配置；用户可保留当前表单直接重试。
      setSaveError("设置保存失败，请检查磁盘后重试");
    });
  }, []);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      persist(next);
      return next;
    });
  }, [persist]);

  const updateKey = useCallback(
    (providerId: string, key: string) => {
      setSettings(prev => {
        if (!prev) return prev;
        const next = { ...prev, apiKeys: { ...prev.apiKeys, [providerId]: key } };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const updateModel = useCallback((providerId: string, model: string) => {
    setSettings(prev => {
      if (!prev) return prev;
      const next = { ...prev, models: { ...prev.models, [providerId]: model } };
      persist(next);
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
            placeholder={apiKey ? "已保存（输入即覆盖）" : "sk-…"}
            autoComplete="off"
          />
        </label>
      )}
      {preset?.keysUrl && (
        <p className="settings-note">
          还没有 Key？<a href={preset.keysUrl}>{preset.keysUrl}</a>（浏览器打开）
        </p>
      )}

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
              onChange={e => preset && updateModel(preset.id, e.target.value)}
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

      <TimerConfigSection settings={settings} update={update} />

      <MemoriesSection />

      <OnboardingSection update={update} />

      <DangerZone />

      <p className="settings-note settings-note--foot">
        Key 保存在本机应用数据目录（settings.json），不上传任何服务器。
      </p>
    </div>
  );
}

/**
 * 计时配置 —— v0.7.0：站立间隔/番茄钟时长/通知开关。
 * 保存即广播 settingsChanged（settings.ts），常驻服务热更新（改站立间隔即重置计时，
 * learning/08 §4.2）。数值边界由 settings.normalize 夹紧（1~120 等）。
 */
function TimerConfigSection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
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
          onChange={e => update({ standupIntervalMin: Number(e.target.value) })}
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
            onChange={e => update({ pomodoroFocusMin: Number(e.target.value) })}
          />
        </label>
        <label className="settings-field">
          <span>休息（分钟）</span>
          <input
            type="number"
            min={1}
            max={30}
            value={settings.pomodoroBreakMin}
            onChange={e => update({ pomodoroBreakMin: Number(e.target.value) })}
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
