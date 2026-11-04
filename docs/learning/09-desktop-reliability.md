# 09 · 桌宠稳定性：原生脉冲、提醒交付与窗口队列

> 对应版本：v0.8.1 稳定性修复（2026-11-04）。前置：[06 Tauri](06-tauri-for-frontend.md)、[07 边界](07-agent-vs-app-boundary.md)、[08 计时提醒](08-timers-reminders-presence.md)。
> 学完标准：能独立写出按 id 去重的提醒队列、窗口工作区定位、原生脉冲与 TS 截止时间判断；能解释“到点”“已入队”“已确认”之间的区别，以及每种失败由谁重试。

## 1. 目标

桌宠是长期驻留应用。页面初次显示正常，并不能证明隐藏到托盘、系统挂起、提醒同时到达或数据库短暂锁定后仍能工作。本次将这些隐含前提改为显式协议：业务服务决定何时提醒，Rust 接受提醒并管理显示队列，用户确认后再由业务服务保存确认状态。

本文重点走读 `src-tauri/src/lib.rs` 的本批新增语句。Rust 只增加窗口交付与原生唤醒能力；番茄钟状态机、站立间隔、在场策略、提醒 SQL 与重试仍在 TypeScript。Agent 仍只解释用户意图、调用应用工具，没有承担计时或维护提醒状态。

## 2. 核心概念

### 2.1 时间正确与唤醒可靠是两个问题

`deadline = Date.now() + duration` 解决的是“下一次执行时，如何知道是否到点”。它不能保证浏览器恰好会在那一秒执行 `setInterval`。宠物隐藏时，WebView 的后台定时器可能节流；因此新增 Rust 每秒事件作为唤醒来源，JS interval 保留为后备。两者都只是促使服务检查绝对截止时间，不分别维护两套倒计时。

操作系统睡眠时，Rust 线程、WebView 和应用本身都不会正常执行。唤醒后下一次有效节拍按时间戳补发，不能承诺睡眠中、退出后或进程崩溃期间仍有准点弹窗。

### 2.2 到点、交付和确认

| 阶段 | 意义 | 权威位置 |
|---|---|---|
| 到点 | `fire_at <= now`，可以尝试交付 | TS 服务 + SQLite |
| 原生接受 | 首条已经成功 show，或排在已有提醒之后 | Rust `AlertQueue` |
| 已触发但未确认 | 交付过，用户尚未明确读过/关闭 | SQLite `status='fired' AND acknowledged_at IS NULL` |
| 用户确认 | 用户点击、键盘确认，或关闭当前提醒窗口 | Rust 校验当前 id，再广播确认；TS 落确认时间 |

这使系统通知成为附加通道。即使用户关掉通知或系统拒绝通知权限，包含实际正文的应用弹窗仍能交付。

### 2.3 所有权与幂等

每个提醒有稳定 id，例如 `reminder:42`。重试使用同一个 id，原生队列拒绝重复加入；确认也必须携带显示中的 id，旧回调不能关闭下一条。站立提醒的一次周期和番茄钟的阶段提醒各有自己的 id；取消/自动收尾仅移除自己的项。

`dismiss` 与 `acknowledge` 不同：前者是服务撤回或自动收尾，后者是用户确认。若把两者混为一个“关闭窗口”事件，确认喝水提醒就可能误重置站立计时。

### 2.4 临时显示队列与持久业务记录

Rust 的 `VecDeque` 是当前进程的显示队列，不直接保存数据库。持久性由 `ReminderScheduler` 和 `reminders.acknowledged_at` 提供：启动扫描已触发但未确认的行，用原 id 重新入队；确认写库失败会保留待确认令牌并重试。内存队列消失不再意味着这些提醒已被用户确认。

## 3. 业界规范与常见做法

1. **截止时间优于累计 tick。** 即使连续丢失多个节拍，也由实际时间判断下一步；不能假设“调用了 60 次，所以过了 60 秒”。
2. **业务记录与显示交付分层。** 先保证提醒仍可重试，再请求窗口展示；显示失败不能悄悄消费掉数据库记录。
3. **至少一次投递配合幂等。** 崩溃和重启边界很难同时做到不丢与绝不重复。本项目选择未确认提醒可恢复，稳定 id 保证同一进程内重试不重复排队；极端确认落盘中断时可能重新显示，优先避免漏掉未读提醒。
4. **桌面坐标必须包含显示器原点和工作区。** 左侧副屏可以是负坐标，任务栏会缩小工作区；“主屏宽减窗口宽”不是通用定位公式。
5. **窗口副作用留在主线程。** Tauri 默认同步命令运行在主线程，`async` 命令才进入异步任务；本项目的四个提醒命令保持同步，心跳也先调回主线程再访问队列和窗口，避免锁与 UI 线程互相等待。[Tauri 官方说明](https://v2.tauri.app/develop/calling-rust/#async-commands)

## 4. 本项目实现走读

### 4.1 导入、协议常量与类型

以下按实际新增语句解释，可对照 `src-tauri/src/lib.rs`，无需先懂整份 Rust：

| 语句/字段 | 为什么需要 |
|---|---|
| `VecDeque` | 提供 `push_back` 和 `pop_front`，直接表达先到先显示，避免移除数组头部时搬动全部元素 |
| `Mutex` | 包装共享显示队列；各入口必须通过同一锁读取/修改，不能各自留一份“当前提醒” |
| `Duration` | 给原生睡眠间隔一个带单位的类型，避免把毫秒与秒混用 |
| `Emitter` | 引入 Tauri 的发事件能力，使 `emit` / `emit_to` 方法可调用 |
| `EVT_DRAG_PET` | 对应 TS 的 `ui://drag-pet`，只在前端确认是拖动手势后请求原生拖动 |
| `EVT_ALERT_CHANGED` | 只通知提醒 WebView 当前队头内容改变，载荷是 `AppAlert` 或 `null` |
| `EVT_ALERT_ACKED` | 向业务服务广播已确认的 `id/kind`，用于站立重置或提醒确认落库 |
| `EVT_NATIVE_TICK` | 将原生唤醒事件定向发给持有长期服务的 pet 窗口 |

`AlertKind` 是 `Standup / Reminder / Pomodoro` 三种来源的封闭枚举。`#[serde(rename_all = "lowercase")]` 使传输值是 TS 侧使用的 `standup/reminder/pomodoro`，未知来源在反序列化时就会失败。`Clone` 允许为事件生成独立载荷，`Serialize/Deserialize` 用于跨 IPC，`PartialEq/Debug` 用于比较与测试。

`AppAlert` 的 `id/kind/title/body` 都属于一条可见提醒：id 用于幂等与所有权，kind 用于把确认路由到正确服务，title/body 用于显示实际内容。字符串为拥有所有权的 `String`，不引用 JS 临时缓冲区。

`AlertAck` 只序列化 `id/kind`：确认服务不需要重新接收正文，也不能根据正文模糊匹配应该关闭哪一条。

### 4.2 `AlertQueue`：纯内存队列

`#[derive(Default)]` 生成空队列：`items` 是空的 `VecDeque<AppAlert>`，`needs_present` 为 false。后者表示当前队头对应的显示/隐藏操作还没完成，供心跳重试。

`enqueue` 的每一步：

1. `items.iter().any(...)` 按 id 查重，而不是按正文查重；用户可以合法创建两个相同正文的不同提醒。
2. 重复时直接 `return false`，重复请求不改变顺序。
3. `push_back(alert)` 把新项追加到末尾。
4. 返回 true 告诉命令入口确实新增了一项。

`acknowledge` 先通过 `front().is_some_and(...)` 验证“这个 id 正是现在显示的队头”，满足才 `pop_front()`。没有队头或 id 不匹配都返回 `None`，不会继续寻找并删除后面的项。

`dismiss` 先保存 `was_current`，再用 `retain` 移除匹配 id 的项，最后返回是否影响当前显示。删除一个排队项不需要重绘当前窗口，也不会自动确认当前提醒。

### 4.3 Builder、启动与关闭行为

`manage(Mutex::new(AlertQueue::default()))` 把队列交给 Tauri 的应用级状态管理。所有窗口调用四个命令时，通过 `app.state::<Mutex<AlertQueue>>()` 得到同一对象，不会各自建队列。

`generate_handler![...]` 在既有素材扫描、idle 查询命令后注册 `show_app_alert/get_app_alert/ack_app_alert/dismiss_app_alert`。只写函数但不加入此表，前端 `invoke` 会找不到命令；这些属于应用自定义窄命令，不需要向前端开放通用窗口控制权限。

setup 在定位初始宠物后调用 `start_native_tick(app.handle().clone())`。`clone` 是给常驻线程保留一个独立 AppHandle；不借用 setup 结束后将失效的局部变量。

关闭事件继续先 `api.prevent_close()`，以免 Tauri 销毁 WebView。随后区分：

- pet/chat 仍执行 `hide()`，保持常驻服务和页面状态；
- alert 先克隆 AppHandle，再读取当前原生队头，有队头就走带 id 的 `ack_app_alert`；没有队头才直接 hide。否则 Alt+F4 只隐藏窗口，却留下已接受的队头，后续提醒一直排在它后面，用户永远看不到。

真正退出仍由既有“退出 Mochi”路径调用 `app.exit(0)`，本批没有把关闭聊天窗改成退出进程。

### 4.4 拖动事件与旧事件兼容

新增拖动监听仍遵循既有的 AppHandle 所有权模式：先 `let handle = app.clone()`，再把这个副本移入 `move` 闭包；`get_webview_window("pet")` 找到实际窗口，存在时才 `start_dragging()`。前端移动阈值、单双击判定和菜单隔离留在 `pages/pet/gestures.ts` 与 PetApp；Rust 不重复实现手势识别。

旧 `show_alert` 只是调用新版 `position_and_show_alert` 的兼容包装，调用失败被旧无回执协议忽略。新业务路径统一使用有回执的 `show_app_alert`。

旧无 id 的 hide/standup-ack 监听改为调用 `hide_legacy_alert`。它仅在 `get_app_alert(...)` 返回 `Ok(None)` 时允许直接隐藏窗口：

1. 原生队列非空时，旧事件不能误隐藏别的服务当前正在显示的提醒；
2. 查询出错也不擅自隐藏，优先保留用户可见内容；
3. 新通道撤回提醒使用 `dismiss_app_alert(id)`，不依赖无 id 广播。

### 4.5 定位：先取工作区，再计算并显示

`position_and_show_alert` 返回 `Result<(), String>`，每个 `?` 都是一个可以回传 TS 的失败边界：

| 操作 | 解释 |
|---|---|
| 获取 alert 与 pet 窗口，`ok_or(...)` | 找不到窗口时明确失败，不能声称弹窗交付成功 |
| `pet.current_monitor()` | 优先选择宠物所在屏幕；宠物拖到副屏后提醒应跟随 |
| `match` 的 None 分支再 `primary_monitor()` | 仅找不到当前屏时回退主屏，不提前调用并让主屏查询失败破坏有效当前屏 |
| `monitor.work_area()` | 得到屏幕原点与可用区域；考虑任务栏，保留负坐标 |
| `outer_position/outer_size` | 宠物与弹窗几何都使用物理像素，避免缩放比例混算 |
| 调用纯函数 `alert_position` | 将可测试的数学与窗口副作用分开 |
| `set_position(...).map_err(...) ?` | 定位失败直接返回错误，让 TS 后续重试 |
| `show().map_err(...)` | 只有实际窗口 show 成功才报告首条交付成功；没有 `set_focus`，不主动夺走输入焦点 |

`alert_position` 先把工作区四边换成 i64，中间加减用较宽整数；x 取宠物与弹窗水平中心对齐，y 默认取宠物上方 12 物理像素。如果上方越过工作区顶边，就改为宠物下方。最后分别夹紧到工作区：

```text
x = clamp(x, left, max(left, right - alertWidth))
y = clamp(y, top, max(top, bottom - alertHeight))
```

`max(left/top, ...)` 保证工作区小于窗口时 clamp 下界不会大于上界而 panic；这时窗口从工作区原点显示，物理空间本身不足的问题不能靠坐标算法完全消除。

初始宠物定位 `position_pet_bottom_right` 也改用 `monitor.work_area()`：先把 24 逻辑像素边距乘缩放比例变为物理像素，然后在工作区原点上加 `max(0, available - window - margin)`。不再假设主屏原点是 `(0,0)`，也不让初始宠物落在任务栏区域。

### 4.6 `present_alert`：显示队头或收起空队列

这个 helper 把“队列改变”与“窗口副作用”连接起来：

1. 先设 `needs_present = true`。接下来的任何失败都留下“尚未完成”的标记。
2. 用 `emit_to("alert", EVT_ALERT_CHANGED, front().cloned())` 发布当前队头。空队列发布 `null`。先发内容，再显示窗口，减少看到旧正文的机会。
3. 队列为空时找到 alert 并 `hide()`；非空时调用 `position_and_show_alert`。
4. 只有以上步骤成功，才清 `needs_present = false` 并返回 `Ok(())`。

首次 show 失败由 TS 服务重试；切换到下一条过程中临时失败时，队头保留，原生 heartbeat 看到 needs_present 再调用此 helper。

### 4.7 四个命令：每条分支的含义

**共同前提**：四个命令保持普通 `fn` 与 `#[tauri::command]`，没有 `async fn` 或 `#[tauri::command(async)]`。这利用 Tauri 默认主线程执行规则。心跳也先调回主线程后拿锁；不能把命令改成后台执行后，继续持锁等待 `show/hide`，同时让主线程等同一锁。若未来有长任务，应拆出锁外后台计算，再回主线程提交短暂状态变化，不可直接删除此线程约束。

`show_app_alert`：

1. id/title/body 的 trim 结果不能为空；否则拒绝，避免接受无法辨认的提醒。
2. `app.state` 定位应用级队列，`lock().map_err(...) ?` 将锁异常转成可序列化错误。
3. 记录 `was_empty`，决定是否需要立即显示新队头。
4. 调 `enqueue`，若 id 已存在直接成功返回，重复请求不新增弹窗。
5. 空队列加入首条时立即 `present_alert`；若失败，`pop_front()` 撤回刚加入的项，再尝试呈现空队列，最后把原始错误回传 TS。
6. 非空队列加入后返回成功，含义是“已被可靠接受到显示队列”，不是“用户已经看过”。

`get_app_alert`：取状态、加锁、`front().cloned()` 后返回。`Option` 表达当前可能没有提醒；返回拷贝避免把 Mutex 内部借用暴露给 IPC。Alert WebView 首次监听前可能错过变化事件，所以事件之外还必须有这条快照查询。

`ack_app_alert`：

1. 取锁后读取队头；空队列直接成功，重复确认不会报业务崩溃。
2. id 不匹配也成功返回但不改变队列，旧画面回调不能确认新队头。
3. 克隆当前 id/kind 构造 `AlertAck`，先 `app.emit(EVT_ALERT_ACKED, ack)`。广播失败用 `?` 返回，原队头仍在，允许用户重试。
4. 广播成功后 `queue.acknowledge(&id)` 移除当前项。
5. 尝试 `present_alert` 展示下一条。这里的错误由 needs_present + heartbeat 处理；不能因为下一条显示失败，就撤销已经成功发出的用户确认。

`dismiss_app_alert`：取锁后 `queue.dismiss(&id)`；只有删除当前项才 `present_alert`，删除排队项不重绘窗口。它不发 ACK 事件，服务撤回不等于用户已经确认。窗口隐藏/下一条显示失败会返回错误，调用服务可保留清理任务继续重试。

### 4.8 原生 heartbeat 的逐语句解释

`start_native_tick` 的工作不是执行番茄钟，只是唤醒应用服务：

1. `std::thread::Builder::new().name("mochi-clock".into())` 命名一个轻量常驻线程，调试时可区分来源，不引入新的 Rust crate。
2. `spawn(move || loop { ... })` 把独立 AppHandle 移入线程，每轮只睡眠和向 UI 线程排一个短任务；线程随进程结束。
3. `thread::sleep(Duration::from_secs(1))` 提供原生节拍，避免依赖隐藏 WebView 的 JS timer；它不是业务截止时间权威。
4. 每轮克隆 handle 给 `run_on_main_thread(move || ...)`。回主线程后才触及显示队列与窗口，避免后台持锁等待 UI。
5. 先 `emit_to("pet", EVT_NATIVE_TICK, ())`，无业务载荷，pet 中 TS 服务根据各自截止时间处理。
6. 再取得队列锁；仅 `needs_present` 为 true 时重试 `present_alert`，正常情况下不会每秒反复 show 已显示的窗口。
7. 原生启动/排任务/发事件错误不 panic。TS 侧仍保留 JS 后备 heartbeat，原生来源故障不会使所有计时器停止检查。

TS `subscribeHeartbeat` 合并同秒原生事件与 JS interval，避免一秒执行两轮；focus/visibility 恢复强制检查；清理函数同时解绑原生事件、interval 和 DOM 事件。它并未声称原生脉冲可以穿透系统睡眠或 WebView 进程完全失效。

### 4.9 TS 展示与用户输入门

`services/alerts.ts` 的 show/dismiss/get/ack 是单次 invoke 薄封装，保持 reject，调用者才能知道失败。`subscribeAppAlerts` 先安装监听再读取快照，使用 changes 计数：快照返回前若收到新事件，旧快照被舍弃；清理后不再调用 onChange，避免卸载页面被晚到请求写状态。

AlertApp 显示原生队头 title/body，长正文可滚动。键盘 Enter/Space 与点击都走 `AlertActionGate`：

- `useRef` 保持一个同步 `inFlight` 锁，React pending state 仅用于显示，不能代替并发锁；
- `clickCount > 1` 过滤双击后半次，`repeat` 过滤键盘长按；
- 从第一次确认起保留 500ms 冷却，A 很快确认并显示 B 时，同一次手势不能顺带关 B；
- `finish()` 只释放执行锁，不清冷却。队头改变也不重建 gate；正常的新手势稍后仍能确认 B。

### 4.10 未确认提醒如何跨重启恢复

`db.ts` 给 reminders 增加 `acknowledged_at`。旧数据库迁移通过 `PRAGMA table_info` 判断是否需要 ALTER；使用 `-1` 作为迁移回填标记，再把旧 fired 记录填入已有 fired_at/created_at，把旧 active/cancelled 恢复为 NULL，防止所有历史 fired 在升级时突然重新弹出。若 ALTER 后回填短暂失败，下次开库仍会处理 -1；双窗口同时迁移时重读列确认另一窗口已完成，而不是把重复 ALTER 当成永久失败。

新提醒创建时 acknowledged_at 为 NULL。Scheduler 启动立即扫描：active 到期的行条件认领，show 失败条件回滚；已 fired 但 acknowledged_at 仍为空的行重新用稳定 id 入队，恢复时不重复发送系统通知。`delivered` 集合防止同一生命周期每秒重发；这个集合不替代 SQLite，每次新生命周期都会重建。

收到 `appAlertAcked` 后，只接受 kind=reminder 且 id 符合 `reminder:数字` 的事件，把确认时间加入 pendingAcknowledgements。先尝试确认落库，再恢复未确认队列；写库失败保留令牌下次重试，避免刚关掉又立刻弹出。数据库持久确认与原生进程内 FIFO 因此各司其职。

### 4.11 测试在证明什么

`lib.rs` 的 `#[cfg(test)] mod alert_tests` 只在测试编译时启用，生产产物不包含测试 helper。测试 `item` 构造短载荷；其余用真实 `AlertQueue` 方法与 `alert_position`，不依赖 WebView：

| 测试 | 锁定的行为 |
|---|---|
| `queue_deduplicates_delivery_retries` | 同 id 重试不新增项 |
| `stale_ack_cannot_remove_current_or_next` | 错 id 不移除，重复确认 A 不移除 B |
| `dismiss_pending_does_not_touch_current` | 撤回排队项不改变当前项 |
| `alert_is_clamped_inside_negative_monitor_work_area` | 负坐标屏左右/上下边界仍可见 |
| `top_edge_uses_below_and_tiny_work_area_never_panics` | 顶边改向下，小工作区 clamp 不 panic |

TS 的 `alerts.test.ts` 覆盖初载快照、慢快照顺序、卸载清理和原生失败回传；`action-gate.test.ts` 覆盖同步互斥、跨队头双击、长按与失败后重试。计时/调度测试还需覆盖原生节拍、显示失败重试与未确认恢复，见对应版本实施记录。

**验证范围**：本次环境缺 MSVC `vcvars64.bat` 和 Rust/Cargo，执行包装脚本后无法进入 Rust 编译。上述 Rust 测试已添加，不能写成已运行通过；TS 测试也不能替代多屏、原生拖动、实际通知权限或系统睡眠的桌面验收。验收进度以 `docs/roadmap.md` 为准。

本批最终 CI：代码5ecc73a的 [check run 41797319856](https://github.com/a985987819/MoChi/actions/runs/41797319856) 在Windows/macOS完成141项TS测试、前端构建和6项Rust库测试；本地缺工具链限制不再阻止跨平台编译验证。CI不启动原生窗口，真机GUI验收仍按roadmap保留。

### 4.12 CI 暴露的 macOS idle 查询依赖修复

本地没有 Rust 工具链，后续实际 CI 才暴露 `user-idle 0.2.1` 的 macOS `src/quartz.rs:1` 中 `use Error` 未解析（E0432）。错误来自依赖的 macOS 模块，不是提醒队列。仅以 TypeScript 测试或 Windows 构建推断 macOS 能编译是不成立的。

最小修复保持 Windows 的行为，只替换 macOS 的聚合时长查询。Cargo.toml 中把 `user-idle = "0.2"` 从通用 `[dependencies]` 移到 `[target.'cfg(windows)'.dependencies]`：这条依赖仍在 Windows 使用，但 macOS 不再编译它的 quartz 模块。Cargo.lock 仍记录全目标依赖图，根包依赖集合仍含 user-idle，版本与传递依赖没有变，本次没有手改锁文件或新增 crate。

`lib.rs` 中对应语句按顺序为：

| 语句 | 为什么这样写 |
|---|---|
| `get_idle_seconds()` 调 `platform_idle_seconds()` | 前端仍 invoke 同一命令，TS 的在场检测协议不变 |
| Windows helper 的 `#[cfg(target_os = "windows")]` | 只在 Windows 编译原来的 `UserIdle::get_time()` 路径；错误仍回落 0 |
| FFI 块与 mac helper 的 `#[cfg(target_os = "macos")]` | Windows 不解析/链接 Apple framework，macOS 不引用 user-idle |
| `#[link(name = "CoreGraphics", kind = "framework")]` | 链接 macOS 自带系统框架，不额外拉取某个替代 Rust 库 |
| `unsafe extern "C"` | 声明使用 C ABI 的外部符号；Rust 2024 要求 extern 声明块显式标注 unsafe |
| `state_id: i32` | 对应 Apple `CGEventSourceStateID` 的 int32 枚举表示 |
| `event_type: u32` | 对应 CoreGraphics 事件类型的无符号 32 位表示，允许传“任意输入”标记 |
| 返回 `f64` | 对应 C API 返回的 `CFTimeInterval`（秒，含小数部分） |
| `unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) }` | 0 选择当前登录会话的合并状态，u32::MAX 对应任意输入；不是错误地查询 Null 事件 |
| `seconds.is_finite() && seconds >= 0.0` | 在转换前拒绝 NaN、无穷和负数，避免异常结果把用户判成长期 away |
| `seconds as u64` | 与现有前端协议一致，按完整秒数返回；小数部分不影响 300 秒阈值语义 |
| 其他目标的 cfg helper 返回 0 | 项目支持 Windows/macOS；未实现的平台按在场降级，不因缺失统计错误推迟提醒 |

unsafe 的安全前提写在调用点：两个参数都是按值传入的整数，没有指针、回调、所有权转移或外部资源生命周期；调用仅查询距上次任意输入的聚合时长，不创建 event tap，也不读取键盘/鼠标事件内容。

签名与语义已对照 [Apple CGEventSourceSecondsSinceLastEventType](https://developer.apple.com/documentation/coregraphics/cgeventsource/secondssincelasteventtype(_:eventtype:)?language=objc)、[Apple CGEventSourceStateID](https://developer.apple.com/documentation/coregraphics/cgeventsourcestateid?language=objc)；`CombinedSessionState=0` 另与 [core-foundation-rs 的原始事件源绑定](https://github.com/servo/core-foundation-rs/blob/master/core-graphics/src/event_source.rs) 交叉核验。修复是否完成原生编译必须以后续 CI 结果为准，不能因已替换依赖就提前写“macOS 构建通过”。

## 5. 设计取舍

| 选择 | 收益 | 代价与保留边界 |
|---|---|---|
| Rust 只做原生脉冲和窗口队列 | 隐藏页面不只靠浏览器 timer；业务仍由熟悉的 TS 学习与测试 | 主线程/WebView 完全阻塞时仍会延迟，不能宣称硬实时 |
| 持久未确认记录 + 稳定 id 恢复 | 崩溃/退出后能恢复未读提醒 | 确认与落盘间极端中断可能重放，优先不漏未读 |
| FIFO 提醒而不是共用一条正文 | 多提醒同时到点不覆盖内容 | 后续提醒需要等前一条确认，入队不等于用户看见 |
| 同步短命令 + 主线程 heartbeat | 队列和窗口线程关系清楚，无额外 Rust 依赖 | 不能在命令里做网络或长 SQL，否则阻塞 UI |
| 队头快照 + 变化事件 | 初载和页面慢加载都能恢复当前内容 | 要显式防旧快照覆盖新事件，并清理卸载监听 |
| 同步确认门 + 500ms 冷却 | 快速显示下一条时双击/长按不会连清队列 | 真正要确认下一条也需短暂等待，这是防误触的明确代价 |

## 6. 复盘自测（默写伪代码清单）

**双平台 CI 补充走读**：旧代码在 macOS cfg 分支中调用 `Builder.set_activation_policy`，但锁定的 Tauri 2.12.5 只在 App/AppHandle 提供该方法。现在在 `.setup(|app| { ... })` 内先用 `#[cfg(target_os = "macos")]` 隔离平台，再调用 `app.set_activation_policy(Accessory)`。Windows 编译不会经过 macOS cfg，故单平台绿灯不能证明条件编译另一侧正确。依据：[官方 app.rs](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/app.rs)（2026-11-04核验）。

1. 默写业务到点、原生接受、用户确认三层状态，并给出各自的权威位置。为何 show 成功不能直接代表 acknowledged？
2. 默写 `enqueue/acknowledge/dismiss`。为何 acknowledge 只能删除匹配的队头，而 dismiss 可以移除任意匹配项？
3. 默写 `present_alert` 的 needs_present 设置顺序；分别说出首次 show 失败、切换下一条失败由谁重试。
4. 默写 show 命令从非空校验、取状态、加锁、入队到首条显示失败回滚的全过程。
5. 为什么四个命令保持同步，原生线程还要 `run_on_main_thread`？把命令直接改 async 后继续持锁调用窗口可能发生什么？
6. 根据当前显示器 work_area 算出弹窗坐标；若宠物位于负坐标屏顶边，先向上还是向下？工作区小于窗口为什么不能直接 clamp？
7. 默认宠物右下角定位为什么既需要 scale_factor，又需要 work_area.position？
8. 默写原生事件 + JS 后备的同秒合并与恢复焦点强制检查；机器睡眠时哪一层还能执行？
9. 慢快照返回前已经收到 B 的事件，为什么不能把画面改回快照 A？如何保证卸载后不再写 UI？
10. React pending state 为何不能作为唯一确认锁？默写阻止双击跨队头和键盘长按的 ActionGate。
11. 默写提醒 active→fired→acknowledged 的 SQL 条件；show 失败怎样恢复？fired 但未确认的行如何跨重启恢复？
12. 旧库新增 acknowledged_at 后为什么不能把所有历史 fired 都当未读重放？-1 迁移标记如何处理 ALTER 后回填中断？
13. 写出本次测试能证明和不能证明的各三项；没有 Rust 工具链时，版本记录应该怎样表达验证结果？

## 7. 延伸阅读

- [Tauri：Calling Rust / Async Commands](https://v2.tauri.app/develop/calling-rust/#async-commands)：同步命令与异步任务的执行线程，后续改造前必须重读。
- [Tauri 2.12.5 Monitor::work_area](https://docs.rs/tauri/2.12.5/tauri/window/struct.Monitor.html#method.work_area)：本项目锁定版本的工作区 API。
- [Tauri 2.12.5 PhysicalRect](https://docs.rs/tauri/2.12.5/tauri/struct.PhysicalRect.html)：position 与 size 的物理像素结构。
- [Rust VecDeque](https://doc.rust-lang.org/std/collections/struct.VecDeque.html)、[Mutex](https://doc.rust-lang.org/std/sync/struct.Mutex.html)：队列与共享状态的标准库实现。
- 本项目：[04 记忆与 SQLite](04-memory.md)、[07 Agent 与应用边界](07-agent-vs-app-boundary.md)、[08 计时与在场检测](08-timers-reminders-presence.md)。

官方接口核验日期：2026-11-04；具体运行验收结果仍以版本记录与 roadmap 为准。
