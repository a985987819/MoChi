import { useCallback } from "react";
import idleImg from "@/assets/pet/idle.svg";

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
 */

interface WelcomeGuideProps {
  /** destination 决定关闭后落在哪个 Tab */
  onFinish: (destination: "chat" | "settings") => void;
}

interface Step {
  title: string;
  desc: string;
}

const STEPS: Step[] = [
  {
    title: "先找到我",
    desc: "我在屏幕右下角，不占任务栏。看不见就看系统托盘的小图标：左键点一下显示 / 隐藏我，右键有菜单。",
  },
  {
    title: "记住三个手势",
    desc: "按住我可以拖到任意位置；双击我打开这个聊天窗口；单击我，我会弹一下，顺便把久坐计时清零。",
  },
  {
    title: "让我真的会说话",
    desc: "去「设置」选 DeepSeek 并粘贴 API Key，就能自由对话。暂时没有 Key 也没关系，默认的演示模式可以先玩遍所有界面。",
  },
  {
    title: "这些事可以直接对我说",
    desc: "「帮我加个待办：明天九点开周会」「来个番茄钟」「半小时后提醒我喝水」「巨无霸多少热量」。",
  },
];

export function WelcomeGuide({ onFinish }: WelcomeGuideProps) {
  const goSettings = useCallback(() => onFinish("settings"), [onFinish]);
  const goChat = useCallback(() => onFinish("chat"), [onFinish]);

  return (
    <section className="welcome" aria-label="新手引导">
      <header className="welcome__hero">
        <img className="welcome__avatar" src={idleImg} alt="" draggable={false} />
        <div className="welcome__hello">
          <h1>你好，我是 Mochi</h1>
          <p>一只住在你桌面上的小麻薯。先花 30 秒认识一下我。</p>
        </div>
      </header>

      <ol className="welcome__steps">
        {STEPS.map((step, i) => (
          <li key={step.title} className="welcome-step">
            <span className="welcome-step__no" aria-hidden>
              {i + 1}
            </span>
            <div className="welcome-step__body">
              <span className="welcome-step__title">{step.title}</span>
              <span className="welcome-step__desc">{step.desc}</span>
            </div>
          </li>
        ))}
      </ol>

      <div className="welcome__actions">
        <button className="welcome__btn welcome__btn--primary" onClick={goSettings}>
          去配置 API Key
        </button>
        <button className="welcome__btn" onClick={goChat}>
          先随便逛逛
        </button>
      </div>

      <p className="welcome__foot">
        聊天记录、待办、记忆都只存在这台电脑上，随时可以在设置里清空。
        <br />
        这份引导之后能在「设置 → 重新显示新手引导」再看一次。
      </p>
    </section>
  );
}
