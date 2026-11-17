/**
 * 音效（v0.12.0）—— 用 Web Audio **合成**，不打包任何音频文件。
 *
 * # 为什么合成而不是带资源
 *
 * 需要的声音只有三种：点击"啵"、提醒两声、番茄三声。打包 mp3/wav 要处理体积、
 * 采样率、循环点，还要在仓库里放二进制；用 `OscillatorNode` + 指数包络，二十行就够，
 * 而且天然可调（音量、音高）。
 *
 * # 设计约束
 *
 * - **懒创建**：`AudioContext` 在第一次真要发声时才建；用户关了开关就一个都不建。
 * - **失败即退**：某些环境（无音频设备、被策略拦）会抛异常；一旦失败就标记不可用，
 *   不再重试——声音是锦上添花，绝不能反过来影响提醒本身。
 * - **点击不受免打扰影响**：那是用户主动操作，静默它只会让人以为程序卡了。
 *   `playAlert` 在免打扰时段直接返回（站立提醒本来就已静默，这里兜住未来新增类型）。
 * - **包络**：起音 8ms 指数上升、按音符时长指数衰减，避免方波般的"咔"声。
 */

import { isQuietHour } from "@/services/quiet-hours";

export type SoundKind = "click" | "standup" | "pomodoro" | "reminder";

/** 一个音符：频率 / 时长 / 相对音量（0~1，最终还会乘以用户音量） */
export interface Tone {
  hz: number;
  ms: number;
  gain: number;
}

/**
 * 每种音效的音符表（纯函数，可单测）。
 *
 * 音高都在 500~1000Hz 的"轻提示"区间：低于 400 会闷、高于 1500 会刺耳。
 * 两个音足够区分类型，三个音只在番茄钟用（"完成—休息—继续"的三段感）。
 */
export function planFor(kind: SoundKind): Tone[] {
  switch (kind) {
    case "click":
      return [{ hz: 880, ms: 70, gain: 0.05 }];
    case "standup":
      return [{ hz: 660, ms: 140, gain: 0.1 }, { hz: 880, ms: 170, gain: 0.08 }];
    case "pomodoro":
      return [
        { hz: 523, ms: 120, gain: 0.09 },
        { hz: 659, ms: 120, gain: 0.08 },
        { hz: 784, ms: 190, gain: 0.07 },
      ];
    case "reminder":
      return [{ hz: 740, ms: 120, gain: 0.1 }, { hz: 988, ms: 190, gain: 0.08 }];
    default:
      return [];
  }
}

/** 设置里的 0~100 音量 → 0~1 增益；异常值回落到默认 30% */
export function clampVolume(percent: number): number {
  if (!Number.isFinite(percent)) return 0.3;
  return Math.min(1, Math.max(0, percent / 100));
}

interface AudioScope {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

let context: AudioContext | null = null;
let unavailable = false;
let enabled = true;
let volume = 0.3;
let quiet = { enabled: false, start: 0, end: 0 };

/** 由宠物窗在启动/设置变更时调用；开关关闭会顺带释放已创建的 AudioContext */
export function configureSound(next: {
  enabled: boolean;
  volumePercent: number;
  quietHours: { enabled: boolean; start: number; end: number };
}): void {
  enabled = next.enabled;
  volume = clampVolume(next.volumePercent);
  quiet = next.quietHours;
  if (!enabled && context) {
    void context.close().catch(() => undefined);
    context = null;
  }
}

/**
 * 取（或懒创建）AudioContext。失败一次就永久标记不可用：
 * 反复重试只会让每次点击都多一次异常开销。
 */
function ensureContext(): AudioContext | null {
  if (unavailable) return null;
  if (context) {
    // WebView 可能在后台挂起音频；发出前顺手恢复，失败不管
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    return context;
  }
  try {
    const scope = globalThis as unknown as AudioScope;
    const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Ctor) {
      unavailable = true;
      return null;
    }
    context = new Ctor();
    return context;
  } catch {
    unavailable = true;
    return null;
  }
}

function play(kind: SoundKind): void {
  if (!enabled || volume <= 0) return;
  // 点击音是用户主动操作，不参与免打扰；提醒类才静默
  if (kind !== "click" && quiet.enabled && isQuietHour(Date.now(), quiet.start, quiet.end)) return;
  const audio = ensureContext();
  if (!audio) return;
  const tones = planFor(kind);
  if (tones.length === 0) return;
  let at = audio.currentTime;
  for (const tone of tones) {
    try {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = tone.hz;
      const seconds = tone.ms / 1000;
      const peak = Math.max(0.0002, tone.gain * volume);
      // 指数包络：起音 8ms（避免爆音），到音符结束衰减到近零
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + Math.min(0.008, seconds / 2));
      gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + seconds + 0.02);
      at += seconds;
    } catch {
      // 单个音符失败不影响其它音符，更不影响提醒本身
    }
  }
}

/** 点击宠物的极轻反馈音 */
export function playClick(): void {
  play("click");
}

/** 提醒类音效（站立 / 番茄 / 自定义提醒） */
export function playAlert(kind: Exclude<SoundKind, "click">): void {
  play(kind);
}
