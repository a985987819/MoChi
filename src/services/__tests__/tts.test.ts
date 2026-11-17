import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureTts,
  plainTextForSpeech,
  setTtsRuntimeForTests,
  speak,
  stopSpeaking,
  trimForSpeech,
  type SpeechSynthesisUtteranceLike,
  type SynthesisLike,
} from "@/services/tts";

/**
 * TTS（v0.15.0）能自动验证的部分：文本纯化/截断纯函数 + 运行时注入下的行为门禁。
 * 音色听感、打断的真机效果无法脚本化——留给真机验收（任务单/版本文档）。
 *
 * 验收红线「开关关闭时不调用 speechSynthesis」在这里用假对象断言：
 * speak 次数必须为 0，cancel 也不能碰（"不触碰"就是字面意思）。
 */

interface RecordingSynth extends SynthesisLike {
  spoken: string[];
  cancels: number;
  voices: Array<{ name: string; lang: string }>;
}

function makeSynth(voices: Array<{ name: string; lang: string }> = []): RecordingSynth {
  const synth: RecordingSynth = {
    spoken: [],
    cancels: 0,
    voices,
    speaking: false,
    cancel: vi.fn(() => {
      synth.cancels += 1;
      synth.speaking = false;
    }),
    speak: vi.fn((u: SpeechSynthesisUtteranceLike) => {
      synth.spoken.push(u.text);
      synth.speaking = true;
    }),
    getVoices: vi.fn(() => synth.voices),
  };
  return synth;
}

let synth: RecordingSynth;
let lastUtterance: SpeechSynthesisUtteranceLike | null = null;

/** 工厂记录最近一次构造的 utterance（断言 rate/voice 用） */
function recordingUtterance(text: string): SpeechSynthesisUtteranceLike {
  const u: SpeechSynthesisUtteranceLike = { text, rate: 1, volume: 1, voice: null };
  lastUtterance = u;
  return u;
}

beforeEach(() => {
  synth = makeSynth();
  lastUtterance = null;
  setTtsRuntimeForTests({ synth, utterance: recordingUtterance });
  // 每个用例显式重置配置：config 是模块级状态，上一个用例的免打扰时段会渗到
  // 下一个用例（真实事故源）。新 synth 未在朗读，重置触发的 stopSpeaking 是空操作。
  configureTts({ enabled: false, rate: 1, voiceName: "", quietHours: { enabled: false, start: 22, end: 8 } });
});

afterEach(() => {
  setTtsRuntimeForTests(null);
});

/** 构造"当前必处于静默中"的免打扰时段：[当前小时, 下一小时) 恒覆盖 now */
function alwaysQuietNow() {
  const hour = new Date().getHours();
  return { enabled: true, start: hour, end: (hour + 1) % 24 };
}

describe("speak 的行为门禁", () => {
  it("开关关闭时完全不触碰 speechSynthesis（验收红线）", () => {
    speak("你好");
    expect(synth.spoken).toHaveLength(0);
    expect(synth.cancels).toBe(0);
  });

  it("开关打开时正常朗读，rate 传入 utterance", () => {
    configureTts({ enabled: true, rate: 1.5 });
    speak("你好，麻薯");
    expect(synth.spoken).toEqual(["你好，麻薯"]);
    expect(lastUtterance?.rate).toBe(1.5);
    expect(lastUtterance?.volume).toBe(1); // 朗读音量独立于音效音量（恒 1）
  });

  it("连续两次 speak：第二条开念前 cancel 打断第一条", () => {
    configureTts({ enabled: true });
    speak("第一条");
    expect(synth.cancels).toBe(0); // 首次朗读不需要打断
    speak("第二条");
    expect(synth.cancels).toBe(1); // 打断上一条的证据
    expect(synth.spoken[synth.spoken.length - 1]).toBe("第二条");
  });

  it("免打扰时段内不朗读（连合成器都不碰）", () => {
    configureTts({ enabled: true, quietHours: alwaysQuietNow() });
    speak("静默时段不该读出来");
    expect(synth.spoken).toHaveLength(0);
    expect(synth.cancels).toBe(0);
  });

  it("纯代码块回复没的可念（静默而非念符号）", () => {
    configureTts({ enabled: true });
    speak("```\nconst x = 1;\n```");
    expect(synth.spoken).toHaveLength(0);
  });

  it("stopSpeaking：朗读中调用会 cancel，空闲时是安全的空操作", () => {
    stopSpeaking();
    expect(synth.cancels).toBe(0); // 没在读：不惊动合成器
    configureTts({ enabled: true });
    speak("正在念的句子");
    stopSpeaking();
    expect(synth.cancels).toBe(1);
  });

  it("关闭开关立即停读（configureTts 内部 stopSpeaking）", () => {
    configureTts({ enabled: true });
    speak("正在念的句子");
    configureTts({ enabled: false });
    expect(synth.cancels).toBe(1);
    speak("关掉之后再说话");
    expect(synth.spoken).toHaveLength(1); // 只有此前那句，不再新增
  });

  it("音色：指定名命中；空名按 zh-CN → zh → 默认逐级回落", () => {
    const zhCn = { name: "Huihui", lang: "zh-CN" };
    const zhTw = { name: "Tingting", lang: "zh-TW" };
    const en = { name: "Zira", lang: "en-US" };

    synth.voices = [en, zhCn, zhTw];
    configureTts({ enabled: true, voiceName: "Tingting" });
    speak("x");
    expect(lastUtterance?.voice?.name).toBe("Tingting");

    configureTts({ enabled: true, voiceName: "" });
    speak("x"); // zh-CN 优先
    expect(lastUtterance?.voice?.name).toBe("Huihui");

    synth.voices = [en, zhTw];
    speak("x"); // 没有 zh-CN → 任意 zh
    expect(lastUtterance?.voice?.name).toBe("Tingting");

    synth.voices = [en];
    speak("x"); // 全没有 → 默认（不设 voice）
    expect(lastUtterance?.voice).toBeNull();

    synth.voices = [en, zhCn];
    configureTts({ enabled: true, voiceName: "不存在的音色" });
    speak("x"); // 指定名失效 → 默认
    expect(lastUtterance?.voice).toBeNull();
  });

  it("speechSynthesis 不存在的环境（node/异常 WebView）静默不抛", () => {
    setTtsRuntimeForTests({ synth: null });
    configureTts({ enabled: true });
    expect(() => speak("没有合成器也不该抛")).not.toThrow();
  });
});

describe("plainTextForSpeech（Markdown → 可朗读文本）", () => {
  it("无语法中文原样保留", () => {
    expect(plainTextForSpeech("今天记得喝水，午饭后散步十分钟。")).toBe(
      "今天记得喝水，午饭后散步十分钟。",
    );
  });

  it("围栏代码块整体跳过", () => {
    expect(plainTextForSpeech("先看这段：\n```\nSELECT * FROM users;\n```\n就这样")).toBe(
      "先看这段： 就这样",
    );
  });

  it("行内代码念内容不念反引号", () => {
    expect(plainTextForSpeech("用 `useState` 管理状态")).toBe("用 useState 管理状态");
  });

  it("链接念显示文字，图片跳过", () => {
    expect(plainTextForSpeech("参考 [MDN](https://developer.mozilla.org) 与 ![表情](a.png)")).toBe(
      "参考 MDN 与",
    );
  });

  it("粗斜体/标题/列表/引用符号不念", () => {
    expect(plainTextForSpeech("## 标题\n**重点**与*次要*\n- 第一条\n> 引用")).toBe(
      "标题 重点与次要 第一条 引用",
    );
  });
});

describe("trimForSpeech（超长截断）", () => {
  it("短文本原样", () => {
    expect(trimForSpeech("你好")).toBe("你好");
  });

  it("恰好等于上限不截断", () => {
    const text = "啊".repeat(200);
    expect(trimForSpeech(text)).toBe(text);
  });

  it("超过上限截到 N 字并加提示", () => {
    const result = trimForSpeech("啊".repeat(201));
    expect(result.startsWith("啊".repeat(200))).toBe(true);
    expect(result).toContain("长回答只念到这里");
  });

  it("自定义上限生效（未来调参用）", () => {
    expect(trimForSpeech("一二三四五", 3)).toBe("一二三……长回答只念到这里，其余在聊天窗里");
  });
});
