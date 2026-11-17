import { useCallback } from "react";
import idleImg from "@/assets/pet/idle.svg";
import { useT } from "@/shared/i18n/react";
import type { MessageKey } from "@/shared/i18n/zh-CN";

/**
 * 首次启动引导（v0.9.0）—— 覆盖整个聊天窗内容区的「第一课」。
 *
 * # 为什么做在应用内，而不是只靠安装器
 *
 * 安装器的完成页是一次性的、且 macOS 的 .dmg 根本没有安装向导；用户真正需要
 * 指引的时刻是「第一次看见这只团子、不知道能点哪」的那 30 秒。所以引导放在
 * 应用里，跨平台一致，且能直接跳到设置页完成最后一步（配 Key）。
 *
 * # 触发与结束
 *
 * - 触发：`AppSettings.onboardingDone === false`（首装 + 从旧版本升级都会命中）；
 *   首启时宠物窗（pages/pet/main.tsx）会主动把聊天窗叫出来，用户不需要知道
 *   "双击宠物"这个隐藏手势就能看到本页。
 * - 结束：两处出口都会把 onboardingDone 置 true，落盘后不再自动出现；
 *   想再看一次去设置页底部「重新显示新手引导」（emit onboardingRequested）。
 *
 * # 文案原则
 *
 * 每条只说「在哪 + 做什么 + 为什么值得」，不写功能清单式罗列；术语（API Key）
 * 出现时立刻给出不需要它的退路（Mock 模式），避免第一屏劝退。
 * v0.21.0：文案迁入 i18n（步骤表值改为 MessageKey）。
 */

interface WelcomeGuideProps {
  /** destination 决定关闭后落在哪个 Tab */
  onFinish: (destination: "chat" | "settings") => void;
  /** 「以后不再自动显示」（P1-09）：不切 Tab、只落盘退出——给想直接关掉的人 */
  onDismissForever: () => void;
}

interface Step {
  title: MessageKey;
  desc: MessageKey;
}

const STEPS: Step[] = [
  { title: "welcome.step1Title", desc: "welcome.step1Desc" },
  { title: "welcome.step2Title", desc: "welcome.step2Desc" },
  { title: "welcome.step3Title", desc: "welcome.step3Desc" },
  { title: "welcome.step4Title", desc: "welcome.step4Desc" },
];

export function WelcomeGuide({ onFinish, onDismissForever }: WelcomeGuideProps) {
  const { t } = useT();
  const goSettings = useCallback(() => onFinish("settings"), [onFinish]);
  const goChat = useCallback(() => onFinish("chat"), [onFinish]);

  return (
    <section className="welcome" aria-label={t("welcome.aria")}>
      <header className="welcome__hero">
        <img className="welcome__avatar" src={idleImg} alt="" draggable={false} />
        <div className="welcome__hello">
          <h1>{t("welcome.hello")}</h1>
          <p>{t("welcome.intro")}</p>
        </div>
      </header>

      <ol className="welcome__steps">
        {STEPS.map((step, i) => (
          <li key={step.title} className="welcome-step">
            <span className="welcome-step__no" aria-hidden>
              {i + 1}
            </span>
            <div className="welcome-step__body">
              <span className="welcome-step__title">{t(step.title)}</span>
              <span className="welcome-step__desc">{t(step.desc)}</span>
            </div>
          </li>
        ))}
      </ol>

      <div className="welcome__actions">
        <button className="welcome__btn welcome__btn--primary" onClick={goSettings}>
          {t("welcome.configureKey")}
        </button>
        <button className="welcome__btn" onClick={goChat}>
          {t("welcome.explore")}
        </button>
      </div>

      <p className="welcome__foot">
        {t("welcome.privacyNote")}
        <br />
        {t("welcome.replayNote")}
        <button className="welcome__skip" onClick={onDismissForever}>
          {t("welcome.dismissForever")}
        </button>
      </p>
    </section>
  );
}
