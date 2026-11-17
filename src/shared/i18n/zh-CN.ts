/**
 * 简体中文文案 —— **唯一事实源**（P2-03B / v0.19.0）。
 *
 * 规则：
 * - `en.ts` 用 `satisfies Record<MessageKey, string>` 类型级对齐本文件——
 *   这里加一个 key、那边没翻译，编译直接报错（任务单验收标准）；
 * - 插值用 `{name}` 占位（core.ts 的 t 负责替换）。中文没有复数，英文需要
 *   复数的条目按语义写成两条 key（如 todosSection 单独的词序），**不引 i18next**
 *   （任务单：先用简单函数）；
 * - 动态文案生成器（pet-chatter-lines 的 144 条随机文案）刻意不进本文件——
   那是文案创作不是翻译，机械翻译只会更差（任务单明确）。
 *
 * 首批迁移范围：提醒中心 / 待办 / 番茄钟 Tab、提醒弹窗、右键菜单、Tab 栏。
 * 聊天窗正文区、设置页其余分区、新手引导、工具轨迹文案留在中文——
 * 已由 scripts/check-hardcoded-zh.mjs 建档跟踪（运行 `pnpm lint:i18n` 查看）。
 */
export const zhCN = {
  // Tab 栏（聊天窗标题栏）
  "tab.chat": "聊天",
  "tab.todos": "待办",
  "tab.reminders": "提醒",
  "tab.pomodoro": "番茄钟",
  "tab.assets": "素材",
  "tab.settings": "设置",
  "tab.closeWindow": "关闭窗口",
  "common.loading": "加载中…",
  "common.petPlaceholder": "Mochi 占位形象",

  // 周期提醒标签（待办/提醒中心共用，v0.13.0 语义）
  "repeat.daily": "每天",
  "repeat.weekdays": "工作日",
  "repeat.weekly": "每周",

  // 右键菜单（宠物窗）
  "menu.openChat": "打开聊天",
  "menu.todos": "待办",
  "menu.todosCount": "待办（{count}）",
  "menu.reminders": "提醒中心",
  "menu.remindersPending": "提醒中心 · {count} 条待确认",
  "menu.startPomodoro": "开始番茄钟",
  "menu.pomodoroFocus": "番茄钟 · 专注中 {time}",
  "menu.pomodoroBreak": "番茄钟 · 休息中 {time}",
  "menu.standupWaiting": "站立提醒 · 等你点击提醒窗",
  "menu.standupSoon": "站立提醒 · 还剩不到 1 分钟",
  "menu.standupRemaining": "站立提醒 · 还剩 {minutes} 分钟",
  "menu.settings": "设置…",
  "menu.snooze1h": "暂停提醒 1 小时",
  "menu.hidePet": "隐藏麻薯",
  "menu.debug": "调试",
  "menu.quit": "退出 Mochi",
  "menu.gestureHint": "拖动移动 · 单击重置站立 · 双击聊天",

  // 提醒弹窗（alert 窗）
  "alert.titleFallback": "提醒",
  "alert.bodyLoading": "正在读取提醒…",
  "alert.standupAck": "起来活动",
  "alert.standupSnooze": "稍后 5 分钟",
  "alert.hintProcessing": "正在处理…",
  "alert.hintStandupClick": "点击卡片任意处 = 立即重置计时",
  "alert.hintClickToAck": "点击或按 Enter 确认",
  "alert.ariaAck": "确认提醒：{title}",
  "alert.errorLoad": "提醒加载失败，请稍后重试",
  "alert.errorListen": "提醒监听失败，请重新打开应用",
  "alert.errorClose": "暂时无法关闭，请重试",
  "alert.errorSnooze": "暂时无法收起，请重试",

  // 待办 Tab
  "todos.placeholder": "手动加一条待办…",
  "todos.add": "添加",
  "todos.dueLabel": "到点提醒（可选）",
  "todos.loading": "正在读取待办…",
  "todos.loadError": "待办读取失败（数据库暂不可用），稍后自动重试。",
  "todos.emptyLine": "还没有待办。",
  "todos.emptyPrompt": "试试对麻薯说：",
  "todos.emptyExample": "帮我加个待办：明天九点开周会",
  "todos.sectionPending": "未完成 · {count}",
  "todos.sectionDone": "已完成 · {count}",
  "todos.dueToday": "今天 {time}",
  "todos.dueTomorrow": "明天 {time}",
  "todos.ariaDone": "已完成",
  "todos.ariaMarkDone": "标记完成",
  "todos.ariaDelete": "删除",

  // 番茄钟 Tab
  "pomo.phaseIdle": "空闲",
  "pomo.phaseFocus": "专注中",
  "pomo.phaseBreak": "休息中",
  "pomo.start": "开始专注",
  "pomo.stop": "停止",
  "pomo.hintChat": "也可以对麻薯说「来个番茄钟」",
  "pomo.awayMinutes": "本次专注期间离开约 {minutes} 分钟",

  // 提醒中心 Tab（v0.14.0）
  "rem.activeTitle": "进行中（{count}）",
  "rem.loading": "读取中…",
  "rem.activeEmpty": "还没有进行中的提醒。对麻薯说「帮我明天九点提醒交周报」试试",
  "rem.cancel": "取消提醒",
  "rem.skipNext": "跳过一次",
  "rem.skipMarked": "下次将跳过",
  "rem.cancelSeries": "取消整串",
  "rem.errorSkip": "跳过失败，请重试",
  "rem.historyTitle": "历史",
  "rem.historyEmpty": "还没有提醒历史。触发或取消的提醒会留在这里",
  "rem.more": "加载更多",
  "rem.moreLoading": "加载中…",
  "rem.chipPending": "待确认",
  "rem.chipFired": "已触发",
  "rem.chipSkipped": "已跳过",
  "rem.chipCancelled": "已取消",
  "rem.batchChip": "合并交付",
  "rem.batchTitle": "⏰ {count} 条提醒到点了",
  "rem.snooze30": "+30 分钟",
  "rem.snoozeTomorrow": "明天同一时间",
  "rem.errorCreate": "创建提醒失败，请重试",
  "rem.errorCancel": "取消失败，请重试",
  "rem.errorLoad": "提醒数据读取失败，请稍后重试",
  "rem.errorMore": "更多历史读取失败",

  // 设置页 · 语言分区（本分区自身就是 i18n 的示范位）
  "settings.language": "语言 / Language",
  "locale.system": "跟随系统",
  "locale.zhCN": "简体中文",
  "locale.en": "English",
  "settings.languageNote": "聊天窗标签栏、提醒中心、待办、番茄钟、提醒弹窗与右键菜单已支持切换；其余界面将逐步跟进。",
} as const;

export type MessageKey = keyof typeof zhCN;
