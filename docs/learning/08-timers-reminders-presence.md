# 08 · 宠物状态机、在场检测与计时服务（站立提醒 / 番茄钟 / 自然语言提醒）

> 对应版本：v0.7.0（状态集约定 v0.2.0 先行落地）｜ 前置：[06 Tauri](06-tauri-for-frontend.md)、[07 边界](07-agent-vs-app-boundary.md)、[01 循环](01-agent-loop.md)、[03 上下文](03-context-engineering.md)、[04 记忆](04-memory.md)（reminders 表）
> 学完标准：能默写宠物状态优先级表与两个计时状态机；能说清"为什么在场检测只能测 idle、测不了忙碌"；能完整走通"明早九点提醒我"从自然语言到弹通知的每一跳。

## 1. 目标与总览

本文回答四个问题，并给出可直接实现的规格：

1. 桌宠应该有哪些状态？→ §2 状态集、来源、优先级仲裁
2. 能否用鼠标键盘活动判断用户"忙碌"？→ §3 能测什么、不能测什么、怎么接进 Tauri
3. 番茄钟与站立提醒如何实现？→ §4 TimerService：时间基准、状态机、睡眠/唤醒
4. 自然语言约定的任务如何到点自动提醒？→ §5 ReminderService：NL→绝对时间→持久化→触发

与 [07 边界文档](07-agent-vs-app-boundary.md) 的呼应（先读它）：**计时/触发/存储全部归应用；Agent 只做两件事——解释自然语言成结构化指令（create_reminder），以及在合适的时机调用启停工具**。本文所有设计都遵守这条边界。

## 2. 桌宠状态机（v0.2.0 约定 + v0.7.0 扩展）

### 2.1 状态集（v1 全集，对应素材命名 `{state}.{ext}`）

| 状态 | 含义 | 驱动方 | 退出条件 |
|---|---|---|---|
| `idle` | 默认待机（多变体随机轮换） | 应用 | 被更高优先级抢占 |
| `happy` / `sad` | Agent 情绪（被夸/被批评） | Agent（`set_pet_state` 工具） | 持续 6~10s 自动回落，或被抢占 |
| `thinking` | 模型推理/工具执行中 | 应用（AgentEvent：step 开始） | step-end / done |
| `talking` | 文本流式输出中 | 应用（AgentEvent：首个 text-delta） | done |
| `alert` | 站立提醒触发 | 应用（StandupService） | 用户点击弹窗（→`stretch`） |
| `stretch` | 伸展动画（点击弹窗后的奖励） | 应用 | 动画播完（~2s） |
| `focus` / `break` | 番茄钟专注/休息 | 应用（PomodoroService） | 阶段结束或手动停止 |
| `sleep` | 用户离开（无输入超阈值） | 应用（PresenceService） | 输入恢复 |

注意 `thinking`/`talking` 的驱动方是**应用**（从 AgentEvent 流直接映射），不是模型——它们描述"系统正在做什么"，模型没有自知必要。Agent 只决定**情绪类**状态。这个切分能显著减少无意义的工具调用。

### 2.2 优先级仲裁（PetStateManager 的核心规则）

```
alert  >  stretch  >  focus/break  >  sleep  >  mood(happy/sad…)  >  idle
```

| 规则 | 理由 |
|---|---|
| `alert` 最高 | 站立提醒是应用对用户的核心承诺，任何状态都要让位 |
| 番茄钟高于 sleep | 用户离开但番茄钟在跑：承诺仍在进行，宠物保持 `focus`（回来能看到"它一直守着"） |
| sleep 高于 mood | 人都不在了，情绪无意义；防"离开后宠物一直 happy"的怪相 |
| 临时状态限时回落，粘性状态由所属服务释放 | 临时提醒结束后恢复仍有效的专注/站立状态；没有其他状态才回落 `idle` |
| 同优先级新状态覆盖旧状态 | 后到的系统事件/情绪替换先前的 |

实现形态：PetStateManager 持有 `systems: Map<owner, SlotEntry>`、`mood`、`presence`。系统内部先按 `alert > stretch > 其余系统状态` 仲裁，同级取最新；再按 `system > presence > mood > idle` 仲裁，结果改变才广播 `state://pet-changed`。`setSystem(state, durationSec, owner)` 与 `clearSystem(owner)` 只修改所属服务的项；省略 owner 的远程控制/演示使用 `default`。素材命名和回退链不变，见 `docs/pet-assets.md`。

**为何系统层也必须分 owner（2026-11-04 回归修复）**：专注时到点站立，会暂时显示 `alert`；如果二者共用一个字段，确认站立后 `clearSystem()` 就把专注也清掉了。现在 `pomodoro` 持有 focus/break，`standup` 持有 alert/stretch，`reminder` 持有 8 秒提示，各自清理后重新仲裁。无需让服务猜测“此前显示什么”，也不依赖每秒重写专注状态。

### 2.3 迟滞（hysteresis）防抖

状态切换必须有迟滞，否则阈值附近抖动（如 idle 4 分 59 秒→5 分 1 秒来回横跳）：

- 进入 `sleep`：无输入 ≥ **5 分钟**；退出 `sleep`：恢复输入后的下一次轮询（最多约 10 秒）；
- mood 回落：6~10s 随机（机械固定值会显得像机器人）；
- `alert` 超时：弹窗 10 分钟无人点 → 自动播放 `stretch` 并重新计时（用户可能不在座位，别让弹窗堆着）。

## 3. 在场检测：能测什么，不能测什么

### 3.1 操作系统能给我们的唯一可靠信号：**距上次输入的时长**

三大平台都有"查空闲时长"的系统调用，本质是**轮询一个数字**，不是监听事件流：

| 平台 | API | 说明 |
|---|---|---|
| Windows | `GetLastInputInfo`（user32） | 返回最后输入时刻，idle = 当前 tick − 之差；**无需任何权限** |
| macOS | `CGEventSourceSecondsSinceLastEventType(_, kCGAnyInputEventType)`（CoreGraphics） | 直接返回 idle 秒数；查询型 API，无需辅助功能授权（Caffeine 类应用同款） |
| Linux | XScreenSaver 扩展 `XScreenSaverQueryIdleTime` | v1 不做 Linux，仅备案 |

输入包括鼠标移动/点击/键盘/滚轮。Tauri 侧没有内建此能力，需要 Rust 侧加一个命令：

```rust
// src-tauri：候选 crate：user-idle / last-input（跨平台封装）；
// 若维护不佳，手写也就十几行（windows-sys / objc2 core-graphics）
#[tauri::command]
fn get_idle_seconds() -> u64 { idle::get_idle_duration().unwrap_or_default().as_secs() }
```

前端 PresenceService 每 10s 调一次（一个 u64，成本可忽略），带迟滞地维护 `active / away` 两态，广播 `state://presence-changed`。

### 3.2 诚实的结论：**idle 信号 = "在场性"，≠ "忙碌程度"**

| 现实场景 | 输入信号 | 真实状态 | 推断对错 |
|---|---|---|---|
| 写代码/写文档 | 持续输入 | 忙碌（久坐） | ✓ |
| 读纸质书/开会记笔记 | 长时间无输入 | 忙碌（久坐！） | ✗ 会误判为离开 |
| 看视频 | 稀疏输入 | 休闲 | ✗ |
| 去接水/上厕所 | 无输入 | 离开 | ✓ |
| 挂机摸鱼 | 无输入 | 休闲 | ✓ |

所以 v1 的使用边界（写死在设计里）：

- **可以**：驱动 `sleep` 状态；提醒触发时用户不在场 → **推迟到恢复活动再弹**。离开时长统计尚未实现，保留后续候选；
- **不可以**：把"无输入"当成"没在忙"从而跳过站立提醒——读纸质书的用户恰恰是最需要提醒的人。**站立计时不因 away 暂停**，只是弹窗延迟；
- **不做**：前台窗口嗅探（`GetForegroundWindow` 可知用户在看哪个应用，能推断"工作 App = 忙碌"）——隐私敏感度高且超出 v1 范围，列为 v2 备选并需要明示用户开关。

**隐私红线**：我们只读取"距上次输入多少秒"这一个聚合数字；**绝不**接入键盘事件流（如 rdev 监听），绝不记录输入内容。这条写进 README 与设置页说明。

## 4. TimerService：站立提醒与番茄钟

### 4.1 时间基准三原则（整个计时体系的根基）

1. **一切截止时间是时间戳**（`epoch ms`），不是"剩余秒数递减"。`setInterval` 累计每 1000 次能漂移数秒；时间戳永不漂移。
2. **每秒 tick 检查截止时间**：`now >= deadline ? fire() : updateUI()`。v0.8.1 稳定性修订由 Rust 线程每秒发 `state://native-tick` 到 pet，TS `subscribeHeartbeat` 合并原生事件与 JS 后备 interval；同秒不重复计算，恢复焦点/可见性立即复核。隐藏时不再单独依赖被节流的 JS 定时器，但 WebView 完全挂起/系统睡眠时仍只能在恢复后补发，不能承诺硬实时。
3. **睡眠/唤醒**：系统睡眠时 JS 定时器冻结；唤醒后第一次 tick 用时间戳比较即可补发"睡过头"的事件（提醒/阶段结束**只补发一次**，防重复弹窗）。

### 4.2 StandupService（站立提醒）

```
            click(宠物/弹窗)            idle>60min
  [armed] ───────────────→ [armed(重置)]    │
     │  tick: now-deadline  ────────────────┘
     │                                    ▼
     │                              用户在场？──否──→ [fired_deferred]（等 presence 恢复再弹）
     │                                    │是
     │                                    ▼
     │                     [fired] 弹 Alert 窗口 + pet:alert + 系统通知
     │                                    │ 用户点击弹窗
     │                                    ▼
     └──────────────────────── [stretch 动画 2s] ──→ [armed]（重新计时）
```

- 配置：间隔默认 60 分钟（设置 Tab，1~120 分钟）；只有站立间隔改变才重置，修改 Key/模型/通知开关不重置；
- 单击宠物 = 重置（v0.1.0 的 click 处理从"弹跳"升级为"弹跳+reset"——**弹跳保留**，给用户即时反馈）；
- 弹窗点击 = 播放 `stretch` + 重置 + 关闭弹窗；
- 无持久化：重启归零（用户重启机器往往伴随起身，语义合理）。

**弹窗收尾要跨两层**（本次稳定性修订取代旧无 id 事件）：站立服务生成唯一 id，调用 `showAppAlert`；投递失败保留 deadline 并重试。用户确认通过原生 `state://app-alert-acked {id,kind}` 回调，仅匹配本服务当前 id 才重置。超时/单击/改间隔走 `dismissAppAlert(id)`，不确认或关闭别的服务提醒。10 分钟收尾同样比较绝对时间而非只用 setTimeout；投递期间重置，晚到的旧弹窗会按旧 id 收掉。

### 4.3 PomodoroService（番茄钟）

```
  [idle] ──start──→ [focus 25min] ──到点──→ 通知+pet:break ──→ [break 5min]
                     │   │                        │                  │ 到点：通知+pet:happy
                     │   └──stop──→ [idle]        │                  ▼（v1 休息结束自动？）
                     └───────────── 停止随时可用   └────────────→ [idle]，等待手动开始下一轮
```

- **休息结束自动进入下一轮 focus？v1：不自动，回到 idle 等用户开始**。理由：连续自动循环会变成"被应用绑架"，且用户离开时自动续跑的 focus 无意义（番茄钟的精髓是"专注是主动承诺"）；
- focus/break 到点：系统通知 + 宠物状态切换 + Chat 番茄钟 Tab 刷新；
- `stop` 无需确认（打断成本远低于误启）；进行中重启应用 → 放弃本轮（v1 不恢复，roadmap 已定）；
- 长休息（每 4 轮 15min）、轮数统计：v2。
- 本轮 focus 截止时间与 break 时长在启动时固定；热更新只影响下一轮的时长，通知开关仍即时生效。空闲界面显示设置中的专注时长。

### 4.4 与 Agent 的接口（工具，见 [07 边界](07-agent-vs-app-boundary.md) §4.3）

| 工具 | 行为 | 风险级 |
|---|---|---|
| `start_pomodoro(minutes?: number)` | 启动 focus（默认 25，范围 5~90，越界返回 `ok:false` 让模型改） | write |
| `stop_pomodoro()` | 停止当前阶段 | write |
| `get_pomodoro_status()` | 返回当前阶段/剩余秒数 | read |

工具内部**只做参数校验 + 调 PomodoroService**，业务逻辑零重复（07 铁律 2）。系统提示里补充一句："番茄钟由应用计时，你无法'帮用户记住时间'，也不要口头承诺你会提醒"。

#### 4.4.1 实现走读：请求 → 执行 → 回执

`src/services/pomodoro-control.ts` 是 UI/Agent 共用的聊天窗遥控服务：

1. 每次请求生成 `requestId`，先订阅 `state://pomodoro-result`，再发 start/stop/query，防止快速回执早于监听就绪。
2. 宠物窗 `PomodoroService` 同步校验与迁移状态，再返回 `{requestId, result}`。两次并发启动也只有一次成功；非法数字在宿主再次校验。
3. 遥控服务仅接收匹配 id 的回执，完成或 3 秒超时均移除监听。窗口没响应时返回 `ok:false`，不会宣称“已启动”。
4. `PomodoroTab` 挂载时先监听状态广播，再查询快照，解决空闲阶段不广播、刚进入页面读到默认 25 分钟的问题。启动/停止按钮等待回执期间禁用。
5. `agent/tools/pomodoro.ts` 等待相同接口：启动确认使用实际时长，失败原样回传模型；Facade 不再保存一份容易过时的番茄钟缓存。

测试位于 `services/__tests__/timers.test.ts`、`pomodoro-control.test.ts`、`pet-state.test.ts` 与 `agent/tools/__tests__/pomodoro.test.ts`：使用真实服务和 Tauri 官方 IPC/event mocks，用假时钟推进完整阶段、模拟挂起与回执超时；无需等待真实 25 分钟。

## 5. 自然语言定时提醒（NL → 到点自动提醒）

这是 [07 边界](07-agent-vs-app-boundary.md) §5 灰色地带"对话设提醒"的正式设计，随 v0.7.0 落地。

### 5.1 架构：四跳责任链

```
"明早九点提醒我交周报"
   │ ① Agent 理解（意图 + 时间解析）
   ▼
create_reminder({ text:"交周报", fire_at:"2026-11-04T09:00:00+08:00" })
   │ ② 应用校验（可解析/非过去/≤30天）→ ReminderService
   ▼
SQLite reminders 表 + 内存调度器（时间戳 tick）
   │ ③ 到点：在场？→ 弹通知 + pet:alert-lite + 标记 fired
   ▼
用户点击通知/聊天内确认                      （④ 展示与追溯）
```

责任切分：**①是 Agent（时间理解），②③是应用（校验、调度、触发、持久化），④是 UI**。模型从头到尾不"持有"计时——它只是产出一条结构化指令。

### 5.2 时间解析的关键设计

**模型不知道现在几点**——必须由应用在上下文里注入当前时间（[03 上下文](03-context-engineering.md) 的实践）：context-builder 每轮在用户消息前注入一行：

```
（当前时间：2026-11-03 21:05 周二，时区 UTC+8）
```

模型据此把"明早九点/半小时后/下周三"解析为**带时区的绝对时间 ISO 8601**。存储用 epoch ms（跨时区/夏令时安全），展示时再本地化。

应用侧硬校验（工具返回 `ok:false` 时模型会向用户澄清——[01 循环](01-agent-loop.md) 的自愈机制）：

| 校验 | 失败时工具返回的错误（模型会据此追问用户） |
|---|---|
| `fire_at` 可解析 | "时间格式无效，请向用户确认具体时间" |
| 早于当前时间 1 分钟以上 | "时间已过去，请确认用户指的是否明天/下周" |
| 距今 > 30 天 | "超出支持范围（30 天），建议用户改用待办" |
| 相对词无法锚定（如"周末"未指明周六日） | "时间有歧义，请向用户确认" |

**"半小时后"由谁算？** 模型算：`当前 21:05 + 30min = 21:35`，输出绝对时间；应用校验 `|fire_at − now| ∈ [29,31]min` 这种宽松合理性（防模型算错分钟级加法——见 07 §4.1"模型不做长算术"）。真正的精度来自**时间戳**，模型只需要给出"合理近似"。

### 5.3 提醒 vs 待办（工具描述层面的引导）

| | todo | reminder |
|---|---|---|
| 语义 | 有事要做（清单） | 到点要响（闹钟） |
| 存储 | `todos` 表 | `reminders` 表 |
| 用户话术 | "加个待办/记一下" | "到点提醒我/N点叫我" |

两个工具的 `description` 各自写明边界，并互相提示（"如果用户意图是到点通知，请用 create_reminder"）——防止模型用 add_todo 承接"提醒我"的意图然后永远不响。

### 5.4 表结构与调度

```sql
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  fire_at    INTEGER NOT NULL,        -- epoch ms（绝对时间）
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','fired','cancelled')),
  created_at INTEGER NOT NULL,
  fired_at   INTEGER
);
```

ReminderService（应用，确定性）：

- `create(text, fireAt) → id`：落库即排程，启动立即扫，随后原生/后备心跳每秒扫 `active AND fire_at <= now`，提醒变更与恢复 active 也立即补扫；
- **重启存活**：恢复过期 active，并重新交付 `fired AND acknowledged_at IS NULL` 的未确认记录。原生队列只是内存，持久化交付承诺仍在 SQLite；
- 当前触发动作：包含正文的应用弹窗（独立于通知开关）+ 系统通知（可关闭）+ 宠物 `alert` 8s。先条件认领，再 await 原生 show 成功；失败按认领令牌回滚 active，下次重试。已认领后进程崩溃也可从未确认 fired 恢复；
- 触发时用户不在场（§3）：不交付，恢复活动后立即扫描；OS 在场信号仍最多约 10 秒更新一次；
- `cancel(id)` / `list()`：供 UI 与工具使用；cancel 返回被取消条目内容（07 的可追溯规范）。

取消也必须使用条件更新：先 SELECT 仅用于取回可追溯内容，真正写入是 `UPDATE ... WHERE id=$1 AND status='active'`，且只有 `rowsAffected===1` 才返回成功。否则调度器在两条 SQL 之间认领后，取消会错误覆盖 fired 状态；两个取消请求也不能都成功。`services/__tests__/storage.test.ts` 用 Node 22 内置 SQLite 执行真实建表、CRUD、并发认领与取消，IPC 仅替换 SQL 传输层，不接触用户数据库。

#### 5.4.1 未确认恢复与迁移走读（v0.8.1 稳定性修订）

1. 新库 `reminders` 增加 `acknowledged_at INTEGER`，默认 NULL；Store 插入显式写 NULL，`fired` 表示派发过，非“用户看过”。
2. 旧库先 `PRAGMA table_info` 探测，缺列则 `ALTER ... DEFAULT -1`。-1 只用于旧行迁移：旧 fired 回填 `COALESCE(fired_at,created_at)`，旧 active/cancelled 回填 NULL。迁移中断后仍可继续处理 -1，旧通知不会升级后整批重弹；并发 ALTER 重新读列确认。
3. 每轮扫描先重试失败的回滚/确认写入，再查询未确认 fired，按稳定 `reminder:N` 交给原生去重队列；本轮服务的 delivered Set 避免每秒重复派发。恢复不重复发 OS 通知。
4. 用户确认匹配 reminder id 后更新 acknowledged_at；写入失败保存内存令牌重试。确认后、落库前崩溃可能再次提示，选择“宁重复一次也不永久漏掉”。
5. 扫描只有一个在途 Promise；stop/start 使用代号防旧 SQL 返回后继续交付；await 原生 show 成功后也再次校验代号，防止停止后迟到的成功回调污染新生命周期或发送通知。初始化/连接失败可重试。该保证不等于分布式 exactly-once，也不等于退出/断电时可执行代码。

#### 5.4.2 原生显示通道与服务生命周期

原生只承担窗口队列与节拍，业务计时/存储仍在 TS。`show/get/ack/dismiss_app_alert` 是同步主线程命令，Mutex 保护 FIFO，窗口操作和心跳重试也都回主线程。弹窗先监听内容变化再拉取快照，慢快照不能覆盖新队头；确认用同步执行锁、500ms 冷却，忽略双击后半次及按键 repeat，避免连续清掉下一条。几何使用宠物当前显示器 work_area 夹紧，含负坐标屏与任务栏；不抢输入焦点。

`hostServices` 独立启动三类计时服务，失败每五秒重试，不阻塞其他服务；`ServiceScope` 负责异步监听晚到时也正确解绑；HMR 释放旧服务。PresenceService 的查询也接原生心跳，仍按十秒节奏限频，旧查询不能在 stop 后更新状态。PetStateManager.refresh 在心跳清理过期状态，避免临时表情依赖后台 timeout。

原生逐语句教学走读和验收边界见 [09 桌面可靠性](09-desktop-reliability.md)。聊天历史中的提醒系统消息仍未实现，留作候选。

### 5.5 一次性 vs 周期性

v1 **只做一次性**（one-shot）。周期性（"每天九点提醒我站会"）涉及规则引擎（每日/每周/自定义 cron）与"跳过节假日"等语义泥潭，v2 单独立项——模型解析出"重复"意图时应回复"周期提醒下个版本支持，先帮你建今天的？"（引导降级，不假装支持）。

## 6. 实现落点与版本映射

| 能力 | 落地版本 | 关键文件 |
|---|---|---|
| 状态集约定 + PetStateManager（槽位仲裁/回退/素材） | v0.2.0 | `src/services/pet-state.ts`、`docs/pet-assets.md` |
| 状态扩展：thinking/talking（AgentEvent 映射） | v0.4.0 | `src/agent/facade.ts` → emit |
| Rust `get_idle_seconds` + PresenceService + sleep 状态 | v0.7.0 | `src-tauri/src/lib.rs`、`src/services/presence.ts` |
| StandupService / PomodoroService / Alert 弹窗 / 通知 | v0.7.0 | `src/services/timers.ts` |
| reminders 表 + ReminderService + 3 个工具 + 上下文注入当前时间 | v0.7.0 | `src/services/reminders.ts`、`src/agent/core/context-builder.ts` |

新增依赖：Rust `user-idle`（或手写平台层）；无新增 npm 依赖。

## 7. 复盘自测

1. 默写宠物状态优先级链；为什么 sleep 高于 mood、又低于 focus？
2. `thinking`/`talking` 为什么由应用驱动而不是让模型调工具？
3. 迟滞防抖：进入与退出 `sleep` 的阈值为什么不对称？
4. "idle = 在场性，≠ 忙碌程度"——举一个会误判的真实场景，v1 因此做了哪条设计让步？
5. 隐私红线是什么？为什么选"轮询 idle 时长"而不是 rdev 事件流？
6. 时间基准三原则；tick 被节流到 1 次/分钟时，触发最多延迟多少？正确性受损吗？
7. 默写 StandupService 状态机（含 deferred 分支与超时自动收尾）。
8. 番茄钟休息结束为什么不自动开始下一轮 focus？
9. "明早九点提醒我交周报"的四跳责任链，每跳谁负责？"半小时后"由谁算、应用如何兜底模型算错？
10. reminders 表为什么必须持久化而番茄钟不用？用 04 文档的哪个概念解释？
11. 模型解析出"每周一提醒"时 v1 怎么应对？为什么不在 v1 做？
12. 默写按 owner 保存系统状态的 set/clear/recompute；站立确认后为何能恢复 focus？
13. 为什么“事件已发送”不等于“番茄钟启动成功”？默写先监听后发请求、匹配回执、超时清理的顺序。
14. 为什么取消提醒也要带 `status='active'` 条件？SELECT 后直接 UPDATE 存在哪个竞态？

## 8. 延伸阅读

- Win32 `GetLastInputInfo`：https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getlastinputinfo
- Quartz `CGEventSourceSecondsSinceLastEventType`：https://developer.apple.com/documentation/coregraphics/1454634-cgeventsourcesecondssincelast
- crate `user-idle`（跨平台 idle 时长）：https://crates.io/crates/user-idle
- 浏览器定时器节流背景（为何必须时间戳基准）：https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- 本项目对照：`docs/pet-assets.md`（v0.2.0）、`src/services/`（v0.7.0 后）
