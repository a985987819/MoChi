//! Mochi 桌宠 —— Rust 侧入口（v0.1.0：三窗口 + 托盘 + 单实例 + 窗口生命周期管理）。
//!
//! # 架构约定：窗口管理的「单一所有者」
//!
//! Mochi 有三个 WebView 窗口（pet / chat / alert，声明于 `tauri.conf.json`）。
//! 所有**系统级窗口操作**（显示、隐藏、聚焦、退出）只在 Rust 侧进行；前端通过
//! Tauri 事件（`ui://open-chat` 等，见 `src/shared/events.ts`）发起请求，本文件监听并执行。
//!
//! 这样做的原因：
//! 1. **权限最小化**：前端 capability 只给 `core:default`，不授予窗口控制权限；
//! 2. **逻辑单一来源**：托盘、双击宠物、快捷键都汇聚到同一组函数；
//! 3. **学习友好**：前端工程师只需要理解「emit 事件 → Rust 处理」这一条通信协议。
//!
//! # 生命周期模型
//!
//! 应用进程常驻托盘。三个窗口的「关闭按钮/系统关闭」一律被拦截为**隐藏**
//! （见 `on_window_event`），真正退出只走托盘菜单「退出 Mochi」。
//! 宠物窗（pet）是事实上的主窗口：它常驻可见，承载计时器（v0.7.0）等长期服务。
//!
//! # v0.9.0 合并说明
//!
//! v0.8.2 的可靠交付架构（原生提醒队列 + 每秒原生节拍 + 平台隔离的空闲查询）
//! 是本文件的骨架；v0.9.0 的体验功能（window-state 位置持久化、全局快捷键、
//! 开机自启、托盘状态化、宠物大小三档）挂载其上。原独立气泡窗已删除——
//! Agent 回复气泡由宠物窗内的 PetBubble 组件直接监听 `ui://show-bubble` 实现，
//! Rust 不再持有第四窗口与 `bubble://text` 转发链。

use std::{collections::{BTreeMap, VecDeque}, sync::{atomic::{AtomicU64, Ordering}, Mutex}, time::Duration};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Listener, Manager, WindowEvent,
};
use tauri_plugin_window_state::{StateFlags, WindowExt};

/// UI 事件名常量 —— 与 `src/shared/events.ts` 的 `UI_EVENTS` 一一对应。
/// 改名必须两边同步（TS 侧是 `as const` 对象，Rust 侧是这些常量）。
const EVT_OPEN_CHAT: &str = "ui://open-chat";
const EVT_HIDE_CHAT: &str = "ui://hide-chat";
const EVT_TOGGLE_PET: &str = "ui://toggle-pet";
const EVT_QUIT_APP: &str = "ui://quit-app";
const EVT_SHOW_ALERT: &str = "ui://show-alert";
const EVT_HIDE_ALERT: &str = "ui://hide-alert";
const EVT_STANDUP_ACK: &str = "ui://standup-ack";
const EVT_DRAG_PET: &str = "ui://drag-pet";
const EVT_ALERT_CHANGED: &str = "state://app-alert-changed";
const EVT_ALERT_ACKED: &str = "state://app-alert-acked";
const EVT_NATIVE_TICK: &str = "state://native-tick";
/// Rust → chat 窗：open-chat 的 {tab} 载荷转发（P1-02 右键菜单/托盘直达 Tab）
const EVT_CHAT_OPEN: &str = "chat://open";
/// 状态层事件（v0.9.0 P1-03，与 events.ts 的 STATE_EVENTS 对应）——
/// Rust 侧只做两件事：把前端广播的番茄钟状态映射成托盘 tooltip；
/// 托盘菜单动作反向 emit 给宠物窗 Service（沿用 pomodoro-start/stop 先例）
const EVT_POMODORO_CHANGED: &str = "state://pomodoro-changed";
const EVT_POMODORO_START: &str = "state://pomodoro-start";
const EVT_POMODORO_STOP: &str = "state://pomodoro-stop";
/// 暂停站立提醒（P1-03 托盘菜单「暂停 1 小时」/ P1-11 弹窗「稍后」共用）
const EVT_STANDUP_SNOOZE: &str = "state://standup-snooze";
/// 全局快捷键（v0.9.0 P1-13）：前端开关 → Rust 注册；注册结果回传
const EVT_SHORTCUT_CHANGED: &str = "state://shortcut-changed";
const EVT_SHORTCUT_STATE: &str = "state://shortcut-state";
/// 快捷键键位（v1 写死；CmdOrCtrl 在 Windows=Ctrl、macOS=Cmd）
const SHORTCUT_CHAT: &str = "CmdOrCtrl+Shift+M";
/// 开机自启（v0.9.0 P1-14）：前端开关 → Rust 应用（enable/disable 系统项）。
/// v0.9.1 起设置页把它呈现为「开机自动打开」——语义不变：开机后麻薯自动出现。
const EVT_AUTOSTART_CHANGED: &str = "state://autostart-changed";
/// 自启应用结果（Rust → 前端，v0.9.1）：载荷 `{ enabled, ok, error? }`。
///
/// 为什么要回执：`enable()` 返回 Ok 不等于系统真的记住了——安全软件的"启动项
/// 加固"会把注册表值悄悄删掉/回滚。前端只翻转布尔值就会出现「开关开着、开机
/// 却没启动」的假成功。这里执行后用 `is_enabled()` 读回系统真值再广播，
/// 让设置页说人话（成功/被拦截/已失效）。
const EVT_AUTOSTART_STATE: &str = "state://autostart-state";
/// 宠物大小档位（v0.9.0 P1-15）：前端 → Rust（改窗口尺寸）+ 宠物窗（CSS 变量）
const EVT_PET_SCALE_CHANGED: &str = "state://pet-scale-changed";
/// 拖拽状态边界广播（v0.9.0 手感优化）：开始/结束各一次，前端切握持/放下动画
/// 拖拽状态边界广播（v0.9.0 手感优化）：开始/结束各一次，前端切握持/放下动画
const EVT_PET_DRAG_CHANGED: &str = "state://pet-drag-changed";
/// 游戏模式开关（v0.9.0 自迭代）：设置 → Rust，启停前台全屏检测
const EVT_GAME_MODE_CHANGED: &str = "state://game-mode-changed";
/// 自动贴边开关（v0.29.0）：设置 → Rust，同步 enabled；关闭时立即从躲藏恢复
const EVT_AUTO_DOCK_CHANGED: &str = "state://auto-dock-changed";
/// 宠物窗设计基准尺寸（tauri.conf.json 声明值；缩放按逻辑像素乘档位）
const PET_BASE_WIDTH: f64 = 220.0;
const PET_BASE_HEIGHT: f64 = 260.0;
/// 右键菜单需要的最小窗口（逻辑 px，v0.29.1）：菜单 150 宽 + 内边距/滚动条，
/// 高度按“最全展开（含表情演示）”留余量。只影响菜单打开期间的临时窗口尺寸。
const PET_MENU_MIN_WIDTH: f64 = 168.0;
const PET_MENU_MIN_HEIGHT: f64 = 340.0;

/// 原生队列只管理“显示哪条提醒”，计时与提醒持久化仍由 TS 应用服务负责。
#[derive(Clone, serde::Serialize, serde::Deserialize, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
enum AlertKind { Standup, Reminder, Pomodoro }

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
struct AppAlert {
    id: String,
    kind: AlertKind,
    title: String,
    body: String,
}

/// 互斥锁串行化多个窗口同时到达的 show/ack，id 去重使失败重试不产生重复弹窗。
/// 线程约束：以下命令保持同步（Tauri 默认在主线程执行）；heartbeat 也先
/// run_on_main_thread 再取得此锁。不要把命令直接改为 async 后持锁调用窗口 API，
/// 否则可能形成“后台持锁等 UI、UI 等锁”的环路。见 Tauri calling-rust / Async Commands。
#[derive(Default)]
struct AlertQueue {
    items: VecDeque<AppAlert>,
    needs_present: bool,
}

impl AlertQueue {
    fn enqueue(&mut self, alert: AppAlert) -> bool {
        if self.items.iter().any(|item| item.id == alert.id) { return false; }
        self.items.push_back(alert);
        true
    }

    fn acknowledge(&mut self, id: &str) -> Option<AppAlert> {
        if self.items.front().is_some_and(|item| item.id == id) { self.items.pop_front() }
        else { None }
    }

    fn dismiss(&mut self, id: &str) -> bool {
        let was_current = self.items.front().is_some_and(|item| item.id == id);
        self.items.retain(|item| item.id != id);
        was_current
    }
}

#[derive(Clone, serde::Serialize)]
struct AlertAck { id: String, kind: AlertKind }

/// 透明区域点击穿透的状态（v0.9.0 桌宠体检）：宠物窗 220×260 的矩形里，
/// 形象只占底部一块——透明区域会挡住底下窗口的点击（右下角贴着托盘/开始菜单，
/// 这是日常使用的高频痛点）。方案：JS 命中检测 → 穿透时 `set_ignore_cursor_events(true)`；
/// ignore 后 WebView 收不到指针事件，由 Rust 侧低频轮询全局光标**唤回**。
#[derive(Default)]
struct PetHitTest {
    ignore: bool,
    /// 形象矩形（窗口内容区逻辑 px：x, y, w, h）——由 JS 上报
    sprite: Option<(f64, f64, f64, f64)>,
}

/// 右键菜单展开期间的窗口几何备份（v0.29.1）。
///
/// 宠物大小缩到 1.0 以下时窗口只有几十像素，菜单会被 `max-width: calc(100vw-8px)`
/// 压扁。打开菜单前把窗口临时扩到菜单尺寸（原逻辑尺寸 + 原物理位置存在这里），
/// 关闭菜单时原样恢复——菜单因此始终以 1.0 尺寸渲染，与宠物缩放解耦。
#[derive(Default)]
struct PetMenuSpace {
    /// None = 当前没有为菜单扩过窗口（restore 幂等）
    backup: Option<(tauri::LogicalSize<f64>, tauri::PhysicalPosition<i32>)>,
}

/// 纯函数（可单测）：全局光标是否落在宠物形象矩形内。
/// 逻辑矩形按窗口 DPI 缩放换算成物理坐标再比较；margin 给一点手感余量。
fn cursor_hits_sprite(
    cursor: (f64, f64),
    window_pos: (f64, f64),
    scale: f64,
    sprite: (f64, f64, f64, f64),
    margin_logical: f64,
) -> bool {
    if scale <= 0.0 || sprite.2 <= 0.0 || sprite.3 <= 0.0 {
        return false;
    }
    let m = margin_logical * scale;
    let x0 = window_pos.0 + sprite.0 * scale - m;
    let y0 = window_pos.1 + sprite.1 * scale - m;
    let x1 = x0 + sprite.2 * scale + 2.0 * m;
    let y1 = y0 + sprite.3 * scale + 2.0 * m;
    cursor.0 >= x0 && cursor.0 <= x1 && cursor.1 >= y0 && cursor.1 <= y1
}

/// 本地时间戳（素材名兜底用）。v0.16.0 起日志模块已引入 chrono（见 Cargo.toml
/// 注释：它本来就是依赖树里的传递依赖），这里的 unix 秒格式升级为可读的本地时间。
fn chrono_like_now() -> String {
    chrono::Local::now().format("%Y%m%d%H%M%S").to_string()
}

// ── 结构化日志（v0.16.0，P2-01）───────────────────────────────────────────
//
// # 为什么要有它
//
// release 是 `windows_subsystem = "windows"`：没有控制台，所有 `eprintln!` 直接
// 丢失。v0.9.1 排查"开机自启不生效"时只能临时加埋点、构建带控制台的调试版才拿到
// 证据。日志是每次排障都在还的债（任务单 P2-01 背景）。
//
// # 形态（刻意简单）
//
// 一个目录（{appData}/logs/）+ 逐条 open-append-close，**不**引 tracing/log 框架：
// - 量级极低：只记 error/warn/info 级"发生了什么 + 长度/计数"，不是调试 trace；
// - 逐条开合换来跨天/轮转的简单正确——不持有长寿命句柄就没有"句柄指向旧文件"；
// - 前端与 Rust 写**同一个文件**（前端经 append_log 命令上报），排障一处看全。
//
// # 隐私边界（learning/08 §3 的延续）
//
// 绝不写 API Key、聊天正文、提醒正文、窗口标题/进程名——消息源头只写"发生了什么"，
// `redact_message` 兜住"意外带进来"的情况（与前端 redact 同一套规则，双端各一道）。

/// 日志目录名（appData 之下）
const LOG_DIR: &str = "logs";
/// 上次崩溃摘要文件名（单文件覆盖写，「关于」页读取展示）
const LAST_PANIC_FILE: &str = "last-panic.txt";
/// 单文件大小上限：超过就换名另起（-1、-2…），当天主文件继续追加
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// 日志保留天数：更早的文件在启动时清理
const LOG_RETENTION_DAYS: u64 = 7;
/// 单条日志消息上限（字符）：日志不该成为新的存储
const LOG_MESSAGE_MAX_CHARS: usize = 800;

/// tauri.conf.json 的 identifier。panic 钩子在 Builder **之前**运行，拿不到运行时
/// 配置，只能按平台规则手动推导 appData——改名 identifier 时必须同步这里。
const IDENTIFIER_FOR_PANIC: &str = "com.mochi.pet";

/// appData 目录的平台推导（panic 钩子专用——没有 AppHandle 时的兜底路径）。
/// 与 Tauri 官方规则一致：Windows = Roaming AppData、macOS = Application Support。
fn app_data_dir_fallback() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|base| std::path::PathBuf::from(base).join(IDENTIFIER_FOR_PANIC))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|base| std::path::PathBuf::from(base).join("Library/Application Support").join(IDENTIFIER_FOR_PANIC))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        None
    }
}

/// 脱敏（与前端 `redact` 同一套规则）：`sk-` 开头的 Key、`Bearer` 令牌打码，
/// 超长按字符截断。不用 regex crate：就两个前缀模式，手写扫描足够且省依赖。
fn redact_message(message: &str) -> String {
    let masked = mask_prefix_tokens(message, "sk-", 6, "sk-***");
    let masked = mask_prefix_tokens(&masked, "Bearer ", 8, "Bearer ***");
    if masked.chars().count() > LOG_MESSAGE_MAX_CHARS {
        let truncated: String = masked.chars().take(LOG_MESSAGE_MAX_CHARS).collect();
        format!("{truncated}…（截断）")
    } else {
        masked
    }
}

/// 把 `prefix` 后紧跟的连续 [A-Za-z0-9_-] 段（长度 ≥ min_len）替换为 `replacement`。
/// 两个防误伤条件：
/// - **前边界**：前缀必须出现在词边界（前一个字符不是 token 字符），否则
///   "task-skill" 里的 "sk-" 会被当成密钥前缀；
/// - **长度**：短于 min_len 的段不算密钥形态（如 "sk-1"），原样保留。
fn mask_prefix_tokens(message: &str, prefix: &str, min_len: usize, replacement: &str) -> String {
    let is_token_char = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let mut result = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(idx) = rest.find(prefix) {
        let boundary_ok =
            idx == 0 || rest[..idx].chars().next_back().is_none_or(|c| !is_token_char(c));
        if boundary_ok {
            let after = &rest[idx + prefix.len()..];
            let end = after.find(|c: char| !is_token_char(c)).unwrap_or(after.len());
            if end >= min_len {
                result.push_str(&rest[..idx]);
                result.push_str(replacement);
                rest = &after[end..];
                continue;
            }
        }
        // 不满足边界/长度：原样保留到前缀之后，继续向后找（rest 一定变短，无死循环）
        result.push_str(&rest[..idx + prefix.len()]);
        rest = &rest[idx + prefix.len()..];
    }
    result.push_str(rest);
    result
}

/// 日志目录（运行时有 AppHandle 的场景）。拿不到按 None 处理——日志是尽力而为的
/// 旁路，绝不因为日志失败让业务失败。
fn log_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager as _;
    app.path().app_data_dir().ok().map(|p| p.join(LOG_DIR))
}

/// 追加一行到指定目录的当天日志（含 5MB 轮转）。panic 钩子与常规路径共用。
fn append_log_line_at(dir: &std::path::Path, level: &str, scope: &str, message: &str) {
    let now = chrono::Local::now();
    let path = dir.join(format!("mochi-{}.log", now.format("%Y-%m-%d")));
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() >= LOG_MAX_BYTES {
            rotate_log_file(dir, &path);
        }
    }
    let line = format!(
        "[{}] [{}] [{}] {}\n",
        now.format("%Y-%m-%d %H:%M:%S%.3f"),
        level,
        scope,
        redact_message(message)
    );
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write as _;
        let _ = file.write_all(line.as_bytes());
    }
}

/// 运行时日志入口（有 AppHandle）：目录取 appData；目录不可建就静默放弃。
fn append_log_line(app: &tauri::AppHandle, level: &str, scope: &str, message: &str) {
    let Some(dir) = log_dir(app) else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    append_log_line_at(&dir, level, scope, message);
}

/// 单文件超限换名：`mochi-YYYY-MM-DD.log` → `….log.1` → `….log.2`…（保留完整内容）。
/// 序号占满（理论不可能：每天 99 个 5MB）就放弃本次轮转，继续追加直到清理。
fn rotate_log_file(dir: &std::path::Path, path: &std::path::Path) {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return };
    for index in 1..=99u32 {
        let candidate = dir.join(format!("{name}.{index}"));
        if !candidate.exists() {
            let _ = std::fs::rename(path, candidate);
            return;
        }
    }
}

/// 启动清理：删除修改时间早于保留期的**本项目日志文件**。文件名双重校验
/// （`mochi-` 前缀 + `.log`/`.log.N` 后缀）——目录里出现别的文件绝不碰。
fn cleanup_old_logs(dir: &std::path::Path) {
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(LOG_RETENTION_DAYS * 86400);
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        let is_ours = name.starts_with("mochi-")
            && (name.ends_with(".log")
                || name.rsplit_once(".log.").is_some_and(|(_, suffix)| !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())));
        if !is_ours {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}

/// 前端日志上报入口（v0.16.0）：async 命令跑在 tokio 线程池——同步 IO 不占主线程
/// （任务单的坑：别在 native tick / 主线程做同步 IO）。级别白名单、scope 限长；
/// 消息在 append_log_line_at 里统一脱敏。
#[tauri::command]
async fn append_log(app: tauri::AppHandle, level: String, scope: String, message: String) -> Result<(), String> {
    let level = match level.as_str() {
        "error" | "warn" | "info" => level,
        _ => "info".to_string(), // 未知级别降级为 info，而不是拒绝——日志不该报错给业务
    };
    if scope.len() > 64 {
        return Err("scope 过长（应为短标签）".into());
    }
    append_log_line(&app, &level, &scope, &message);
    Ok(())
}

/// 上次崩溃摘要（v0.16.0）：「关于」页展示。文件不存在或为空 = 最近没有崩溃记录；
/// 摘要保留到下一次崩溃为止（它就是"上一次"的凭证，不主动清除）。
#[tauri::command]
fn get_last_panic(app: tauri::AppHandle) -> Option<String> {
    let dir = log_dir(&app)?;
    let content = std::fs::read_to_string(dir.join(LAST_PANIC_FILE)).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

// ── 备份与还原（v0.17.0，P2-02）───────────────────────────────────────────
//
// # 数据源（Windows/macOS 上同目录；plugin-sql 用 appConfigDir、store/pet-assets
// 用 appDataDir，两者在这两个平台指向同一个物理目录，见版本文档）
//
// | 文件            | 内容                                   |
// |-----------------|----------------------------------------|
// | settings.json   | 提供商/模型/Key/称呼/计时/免打扰等      |
// | mochi.db        | 聊天历史、待办、长期记忆、提醒          |
// | pet-assets/     | 用户自定义宠物素材（扁平目录）          |
//
// # 形态决策
//
// - **zip 放固定目录** `{appData}/backups/`，不用 tauri-plugin-dialog：
//   为一次低频操作加插件 + capability 不值得；导入用 `list_backups` 列出可选，
//   外部备份文件拖进 backups 目录即可被识别（revealItemInDir 已有）。
// - **默认不含 API Key**：备份文件容易被拷来拷去（网盘/U盘），密钥不该跟着走；
//   「包含密钥」是显式勾选项。pre-restore 自动备份恒含密钥——它是退路，退路
//   不能比现场更贫瘠。
// - **导入一律先 pre-restore**：覆盖是破坏性动作，没有退路就不许动手。

/// 备份输出/导入来源目录名（appData 之下）
const BACKUP_DIR: &str = "backups";
/// manifest schema 版本：TS 侧 ensureSchema（db.ts）幂等补列，旧备份无需迁移脚本；
/// 这个数字只用来拦"来自更新版本的倒灌"。
const BACKUP_SCHEMA_VERSION: u32 = 1;
/// zip 解压总量上限：pet-assets 可能几十 MB，512MB 是宽裕的滥用防线
const BACKUP_MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
/// 单条目上限（防条目声明尺寸骗过总量检查的早期退出）
const BACKUP_MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;

/// 备份清单条目（list_backups 返回给 UI）
#[derive(serde::Serialize)]
struct BackupInfo {
    name: String,
    size_bytes: u64,
    /// epoch ms（UI 转本地时间显示）
    modified_ms: u64,
}

/// zip 内条目分类（白名单）。任何反斜杠、目录穿越、未知路径一律拒绝——
/// zip slip 是还原功能的头号风险（任务单：解压前校验路径）。
#[derive(Debug, PartialEq)]
enum EntryKind {
    Manifest,
    Settings,
    Database,
    /// pet-assets/ 下的扁平文件名（不含目录分隔）
    Asset(String),
}

/// 纯函数（可单测）：zip 条目名 → 白名单分类。
/// 规则：已知三个根文件 + `pet-assets/<单层文件名>`；其余（`../x`、`C:\x`、
/// `pet-assets/sub/x`、隐藏文件）全部拒绝。
fn classify_entry(name: &str) -> Result<EntryKind, String> {
    if name.contains('\\') {
        return Err(format!("非法条目路径（反斜杠）: {name}"));
    }
    match name {
        "manifest.json" => Ok(EntryKind::Manifest),
        "settings.json" => Ok(EntryKind::Settings),
        "mochi.db" => Ok(EntryKind::Database),
        _ if name.starts_with("pet-assets/") => {
            let rest = &name["pet-assets/".len()..];
            if rest.is_empty() || rest.contains('/') || rest.starts_with('.') {
                Err(format!("非法素材条目: {name}"))
            } else {
                Ok(EntryKind::Asset(rest.to_string()))
            }
        }
        _ => Err(format!("未知条目: {name}")),
    }
}

/// settings.json 的脱 Key 变换（纯函数，可单测）：不含密钥模式下 apiKeys 清空，
/// 其余字段原样保留（结构由 TS 侧 normalize 兜底，导出不做字段白名单）。
/// **解析失败返回空对象而不是原文**——宁可备份丢设置，不可把可能的明文 Key
/// 写进一个会被拷走的文件。
fn strip_api_keys(content: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(mut value) => {
            if let Some(obj) = value.as_object_mut() {
                obj.insert("apiKeys".to_string(), serde_json::json!({}));
            }
            serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
        }
        Err(_) => "{}".to_string(),
    }
}

/// 读取 settings.json 原文（不存在视为空设置——首次导入场景）
fn read_settings_file(data_dir: &std::path::Path) -> String {
    std::fs::read_to_string(data_dir.join("settings.json")).unwrap_or_else(|_| "{}".to_string())
}

/// 导出备份（导出命令与 pre-restore 共用实现）。
/// 返回 zip 路径；调用方负责把路径透传给 UI（reveal/展示）。
fn export_backup_impl(
    app: &tauri::AppHandle,
    include_keys: bool,
    name_prefix: &str,
) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("找不到应用数据目录: {e}"))?;
    let backups_dir = data_dir.join(BACKUP_DIR);
    std::fs::create_dir_all(&backups_dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let out_path = backups_dir.join(format!("{name_prefix}-{stamp}.zip"));

    let file = std::fs::File::create(&out_path).map_err(|e| format!("创建备份文件失败: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // ① manifest：版本/时间/是否含密钥/schema——导入侧的准入校验数据
    let manifest = serde_json::json!({
        "appVersion": app.package_info().version.to_string(),
        "exportedAt": chrono::Local::now().timestamp_millis(),
        "includeKeys": include_keys,
        "schemaVersion": BACKUP_SCHEMA_VERSION,
    });
    zip.start_file("manifest.json", options).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut zip, serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?.as_bytes())
        .map_err(|e| e.to_string())?;

    // ② settings.json（不含密钥模式走 strip_api_keys，见纯函数注释）
    zip.start_file("settings.json", options).map_err(|e| e.to_string())?;
    let settings = read_settings_file(&data_dir);
    let settings = if include_keys { settings } else { strip_api_keys(&settings) };
    std::io::Write::write_all(&mut zip, settings.as_bytes()).map_err(|e| e.to_string())?;

    // ③ mochi.db：WAL checkpoint 由**前端**在导出前执行（它持有写连接，见服务层）；
    //    这里直接拷文件。checkpoint 只是尽力而为——失败时导出的数据最多落后几秒，
    //    属可接受降级（版本文档有记录）。
    zip.start_file("mochi.db", options).map_err(|e| e.to_string())?;
    let db_bytes = std::fs::read(data_dir.join("mochi.db"))
        .map_err(|e| format!("读取数据库失败（应用可能尚未创建过数据）: {e}"))?;
    std::io::Write::write_all(&mut zip, &db_bytes).map_err(|e| e.to_string())?;

    // ④ pet-assets：扁平目录逐文件拷贝；目录不存在 = 用户没放素材，跳过
    if let Ok(entries) = std::fs::read_dir(data_dir.join("pet-assets")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            let mut source = std::fs::File::open(&path).map_err(|e| format!("读取素材 {name} 失败: {e}"))?;
            zip.start_file(format!("pet-assets/{name}"), options)
                .map_err(|e| format!("写入素材条目 {name} 失败: {e}"))?;
            std::io::copy(&mut source, &mut zip).map_err(|e| format!("写入素材 {name} 失败: {e}"))?;
        }
    }

    zip.finish().map_err(|e| format!("收尾备份失败: {e}"))?;
    Ok(out_path)
}

/// 导出备份命令（v0.17.0）。async：zip 压缩可能上百毫秒到数秒，放 tokio 线程池。
#[tauri::command]
async fn export_backup(app: tauri::AppHandle, include_keys: bool) -> Result<String, String> {
    let path = export_backup_impl(&app, include_keys, "mochi")?;
    Ok(path.to_string_lossy().into_owned())
}

/// 列出备份目录里的 zip（UI 的导入列表）。按修改时间倒序；目录不存在 = 还没备份过。
#[tauri::command]
fn list_backups(app: tauri::AppHandle) -> Vec<BackupInfo> {
    use tauri::Manager as _;
    let mut result: Vec<BackupInfo> = Vec::new();
    let Ok(data_dir) = app.path().app_data_dir() else { return result };
    let Ok(entries) = std::fs::read_dir(data_dir.join(BACKUP_DIR)) else { return result };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !name.to_ascii_lowercase().ends_with(".zip") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        result.push(BackupInfo {
            name: name.to_string(),
            size_bytes: meta.len(),
            modified_ms,
        });
    }
    result.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    result
}

/// 导入备份命令（v0.17.0）：校验 → pre-restore → 覆盖三数据源 → 要求重启。
/// **数据库替换走"先改名腾位、再落新文件"**：应用运行时 SQLite 可能持有打开的
/// 文件句柄，直接覆盖在 Windows 上会被拒绝；改名若也失败（无 share-delete），
/// 在动任何数据之前就报错退出，提示先退出应用——没有退路不覆盖。
#[tauri::command]
async fn import_backup(app: tauri::AppHandle, path: String) -> Result<String, String> {
    import_backup_impl(&app, &path)
}

fn import_backup_impl(app: &tauri::AppHandle, path: &str) -> Result<String, String> {
    use tauri::Manager as _;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("找不到应用数据目录: {e}"))?;
    let backups_dir = data_dir.join(BACKUP_DIR);

    // ① 传入路径必须落在备份目录内（canonicalize 化解 .. 与符号链接）
    let requested = std::fs::canonicalize(path).map_err(|_| "备份文件不存在或不可读".to_string())?;
    let canonical_root = std::fs::canonicalize(&backups_dir).map_err(|_| "备份目录不存在".to_string())?;
    if !requested.starts_with(&canonical_root) {
        return Err("只能导入备份目录里的文件".to_string());
    }

    // ② 先读 zip 并全量校验，**全部通过才动现有数据**——半途报错等于现场被毁
    let reader = std::fs::File::open(&requested).map_err(|e| format!("打开备份失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("备份文件不是有效的 zip: {e}"))?;

    let mut manifest_seen = false;
    let mut settings_seen = false;
    let mut database_seen = false;
    let mut total_bytes: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|e| format!("读取条目失败: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        classify_entry(entry.name()).map_err(|e| format!("备份内容校验失败: {e}"))?;
        total_bytes += entry.size();
        if total_bytes > BACKUP_MAX_TOTAL_BYTES {
            return Err("备份解压总量超过 512MB，已拒绝导入".to_string());
        }
        match entry.name() {
            "manifest.json" => manifest_seen = true,
            "settings.json" => settings_seen = true,
            "mochi.db" => database_seen = true,
            _ => {}
        }
    }
    if !manifest_seen || !settings_seen || !database_seen {
        return Err("备份缺少必要文件（manifest.json / settings.json / mochi.db），不是有效的 Mochi 备份".to_string());
    }

    // manifest 校验：schema 更新于当前版本 → 拒绝倒灌（旧备份无需迁移，见常量注释）
    {
        let mut entry = archive.by_name("manifest.json").map_err(|e| e.to_string())?;
        let mut content = String::new();
        std::io::Read::read_to_string(&mut entry, &mut content).map_err(|e| e.to_string())?;
        let manifest: serde_json::Value = serde_json::from_str(&content)
            .map_err(|_| "manifest.json 不是合法 JSON".to_string())?;
        let schema = manifest.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(0);
        if schema > BACKUP_SCHEMA_VERSION as u64 {
            return Err(format!(
                "备份来自更新的版本（schema {schema} > 当前 {BACKUP_SCHEMA_VERSION}），请先升级应用再导入"
            ));
        }
    }

    // ③ pre-restore：覆盖前的自动备份（恒含密钥——退路不能比现场贫瘠）。
    //    失败即中止：没有退路不覆盖（任务单验收标准）。
    let pre = export_backup_impl(app, true, "pre-restore")
        .map_err(|e| format!("覆盖前自动备份失败，已中止导入: {e}"))?;

    // ④ 覆盖三数据源。DB 用"改名腾位"策略（见命令注释）；素材目录清空重写。
    let db_path = data_dir.join("mochi.db");
    let retired = data_dir.join("mochi.db.import-retired");
    let _ = std::fs::remove_file(&retired); // 上次导入的残留
    if db_path.exists() {
        std::fs::rename(&db_path, &retired).map_err(|_| {
            "数据库正被应用占用，无法替换。请先从托盘完全退出 Mochi，再重新执行导入".to_string()
        })?;
    }
    // 旧 WAL/SHM 必须删掉：它们属于被替换的旧库，留着会污染新库
    let _ = std::fs::remove_file(data_dir.join("mochi.db-wal"));
    let _ = std::fs::remove_file(data_dir.join("mochi.db-shm"));

    let write_entry = |archive: &mut zip::ZipArchive<std::fs::File>, entry: &str, target: &std::path::Path| -> Result<(), String> {
        let mut source = archive.by_name(entry).map_err(|e| format!("读取条目 {entry} 失败: {e}"))?;
        if source.size() > BACKUP_MAX_ENTRY_BYTES {
            return Err(format!("条目 {entry} 超过单文件上限"));
        }
        let mut out = std::fs::File::create(target).map_err(|e| format!("写入 {entry} 失败: {e}"))?;
        std::io::copy(&mut source, &mut out).map_err(|e| format!("写入 {entry} 失败: {e}"))?;
        Ok(())
    };

    // 数据库先写临时名再改名落位（写一半崩溃不会留下半截 mochi.db）
    let staging = data_dir.join("mochi.db.importing");
    write_entry(&mut archive, "mochi.db", &staging).map_err(|e| {
        // 写入失败：把旧库还原回去，现场不毁
        let _ = std::fs::remove_file(&staging);
        if retired.exists() {
            let _ = std::fs::rename(&retired, &db_path);
        }
        e
    })?;
    std::fs::rename(&staging, &db_path).map_err(|e| {
        let _ = std::fs::remove_file(&staging);
        if retired.exists() {
            let _ = std::fs::rename(&retired, &db_path);
        }
        format!("数据库落位失败: {e}")
    })?;
    let _ = std::fs::remove_file(&retired);

    write_entry(&mut archive, "settings.json", &data_dir.join("settings.json"))?;

    // pet-assets：清空重写（覆盖语义；旧素材在 pre-restore 里有完整备份）
    let assets_dir = data_dir.join("pet-assets");
    std::fs::create_dir_all(&assets_dir).map_err(|e| format!("创建素材目录失败: {e}"))?;
    if let Ok(entries) = std::fs::read_dir(&assets_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    for index in 0..archive.len() {
        let (kind_ok, name) = {
            let entry = archive.by_index_raw(index).map_err(|e| e.to_string())?;
            (matches!(classify_entry(entry.name()), Ok(EntryKind::Asset(_))), entry.name().to_string())
        };
        if !kind_ok {
            continue;
        }
        if let Ok(EntryKind::Asset(file_name)) = classify_entry(&name) {
            write_entry(&mut archive, &name, &assets_dir.join(&file_name))
                .map_err(|e| format!("恢复素材 {file_name} 失败: {e}"))?;
        }
    }

    Ok(format!(
        "导入完成，重启 Mochi 后生效。覆盖前的旧数据已备份为 {}",
        pre.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ))
}

/// 游戏模式状态（v0.9.0 自迭代）：设置开关（默认关）+ "被本功能隐藏"标记——
/// 后者避免与用户手动 toggle_pet 打架：手动显示后游戏模式只在**新的**全屏事件
/// 里才再次隐藏，退出全屏也只恢复自己隐藏的那次。
#[derive(Default)]
struct GameMode {
    enabled: bool,
    hidden_by_gm: bool,
}

/// 纯函数（可单测）：前台窗口矩形是否"全屏覆盖"其显示器。
/// 阈值 0.97 容忍边界 1~2px 的测量噪声；宽高独立判断（竖屏视频/带边框独占）。
fn is_fullscreen_cover(win: (i32, i32, i32, i32), monitor: (i32, i32, i32, i32)) -> bool {
    let (mw, mh) = (monitor.2 as i64, monitor.3 as i64);
    if mw <= 0 || mh <= 0 {
        return false; // 显示器矩形异常（0/负）：宁可不动宠物也不误隐藏
    }
    let (ww, wh) = ((win.2 as i64).max(0), (win.3 as i64).max(0));
    ww * 100 >= mw * 97 && wh * 100 >= mh * 97
}

/// 自动贴边（v0.29.0）：拖拽松手离屏幕边很近时自动躲藏只留一条（peek），
/// 鼠标靠近该边或有提醒时就近恢复完整显示。开关来自 settings.autoDockEnabled
/// （state://auto-dock-changed 同步）。
#[derive(Default)]
struct AutoDockState {
    enabled: bool,
    peeked: Option<Edge>,
}

/// 躲藏目标边（相对当前显示器工作区）
#[derive(Clone, Copy, PartialEq, Debug)]
enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

/// 触发距离（逻辑 px）：松手时窗口边缘离工作区边 ≤40 逻辑 px 触发躲藏
const DOCK_TRIGGER_LOGICAL: i32 = 40;
/// 躲藏时可见的"一条"宽度（逻辑 px）
const PEEK_SLIVER_LOGICAL: i32 = 16;
/// 唤回区宽度（逻辑 px）：光标进入贴边外侧这条带就恢复显示
const PEEK_WAKE_ZONE_LOGICAL: i32 = 48;
/// 沿边方向的唤回余量（物理 px）：该边 ±120 物理 px 范围内经过都算"经过"
const PEEK_WAKE_SPAN_PAD_PX: i32 = 120;

/// 窗口矩形到工作区四边的距离（物理 px；可为负 = 已溢出该边）。返回 (最近边, 距离)
fn nearest_edge(rect: (i32, i32, i32, i32), area: (i32, i32, i32, i32)) -> (Edge, i32) {
    let (x, y, w, h) = rect;
    let (ax, ay, aw, ah) = area;
    let candidates = [
        (Edge::Left, x - ax),
        (Edge::Right, (ax + aw) - (x + w)),
        (Edge::Top, y - ay),
        (Edge::Bottom, (ay + ah) - (y + h)),
    ];
    candidates
        .into_iter()
        .min_by_key(|(_, d)| d.abs())
        .map(|(e, d)| (e, d))
        .unwrap_or((Edge::Left, i32::MAX))
}

/// 沿边方向把窗口夹在工作区内（躲藏/停靠时另一轴完整可见）
fn clamp_span(origin: i32, span: i32, area_origin: i32, area_span: i32) -> i32 {
    origin.clamp(area_origin, (area_origin + area_span - span).max(area_origin))
}

/// 躲藏位置（物理 px）：窗口沿该边滑出只留 sliver 可见；沿边方向夹在工作区内
fn peek_position(edge: Edge, rect: (i32, i32, i32, i32), area: (i32, i32, i32, i32), sliver: i32) -> (i32, i32) {
    let (x, y, w, h) = rect;
    let (ax, ay, aw, ah) = area;
    match edge {
        Edge::Left => (ax - w + sliver, clamp_span(y, h, ay, ah)),
        Edge::Right => (ax + aw - sliver, clamp_span(y, h, ay, ah)),
        Edge::Top => (clamp_span(x, w, ax, aw), ay - h + sliver),
        Edge::Bottom => (clamp_span(x, w, ax, aw), ay + ah - sliver),
    }
}

/// 停靠位置（物理 px）：完整显示且紧贴该边
fn dock_position(edge: Edge, rect: (i32, i32, i32, i32), area: (i32, i32, i32, i32)) -> (i32, i32) {
    let (x, y, w, h) = rect;
    let (ax, ay, aw, ah) = area;
    match edge {
        Edge::Left => (ax, clamp_span(y, h, ay, ah)),
        Edge::Right => (ax + aw - w, clamp_span(y, h, ay, ah)),
        Edge::Top => (clamp_span(x, w, ax, aw), ay),
        Edge::Bottom => (clamp_span(x, w, ax, aw), ay + ah - h),
    }
}

/// 唤回判定（纯函数）：光标位于贴边外侧 wake 带内，且沿边方向落在窗口跨度
/// ± pad 范围内——"鼠标经过躲藏的那条边附近"才算经过
fn cursor_wakes_peek(cursor: (i32, i32), edge: Edge, rect: (i32, i32, i32, i32), area: (i32, i32, i32, i32), zone: i32) -> bool {
    let (cx, cy) = cursor;
    let (x, y, w, h) = rect;
    let (ax, ay, aw, ah) = area;
    let span_ok = |origin: i32, span: i32, pos: i32| {
        pos >= origin - PEEK_WAKE_SPAN_PAD_PX && pos <= origin + span + PEEK_WAKE_SPAN_PAD_PX
    };
    match edge {
        Edge::Left => cx >= ax - zone && cx <= ax + zone && span_ok(y, h, cy),
        Edge::Right => cx >= ax + aw - zone && cx <= ax + aw + zone && span_ok(y, h, cy),
        Edge::Top => cy >= ay - zone && cy <= ay + zone && span_ok(x, w, cx),
        Edge::Bottom => cy >= ay + ah - zone && cy <= ay + ah + zone && span_ok(x, w, cx),
    }
}

/// 从躲藏状态恢复（物理 px 定位回停靠位）：peeked 清空
fn restore_from_peek(app: &tauri::AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else { return };
    let (Ok(pos), Ok(size)) = (pet.outer_position(), pet.outer_size()) else { return };
    let monitor = match pet.current_monitor() {
        Ok(Some(m)) => m,
        _ => match pet.primary_monitor() {
            Ok(Some(m)) => m,
            _ => return,
        },
    };
    let area = monitor.work_area();
    let peeked = app
        .state::<Mutex<AutoDockState>>()
        .lock()
        .ok()
        .and_then(|st| st.peeked);
    let Some(edge) = peeked else { return };
    let docked = dock_position(edge, (pos.x, pos.y, size.width as i32, size.height as i32), (area.position.x, area.position.y, area.size.width as i32, area.size.height as i32));
    let _ = pet.set_position(tauri::PhysicalPosition::new(docked.0, docked.1));
    if let Ok(mut st) = app.state::<Mutex<AutoDockState>>().lock() {
        st.peeked = None;
    }
}

/// 拖拽收尾后的自动贴边判定（v0.29.0）：开关开 + 最近边距离 ≤ 触发距离 →
/// 滑出只留一条（peek）。底部边不躲藏——宠物置顶会盖住任务栏。
fn maybe_auto_dock(app: &tauri::AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else { return };
    let (enabled,) = {
        let state = app.state::<Mutex<AutoDockState>>();
        match state.lock() {
            Ok(st) => (st.enabled,),
            Err(_) => return,
        }
    };
    if !enabled { return; }
    let (Ok(pos), Ok(size)) = (pet.outer_position(), pet.outer_size()) else { return };
    let monitor = match pet.current_monitor() {
        Ok(Some(m)) => m,
        _ => match pet.primary_monitor() {
            Ok(Some(m)) => m,
            _ => return,
        },
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let rect = (pos.x, pos.y, size.width as i32, size.height as i32);
    let area_t = (area.position.x, area.position.y, area.size.width as i32, area.size.height as i32);
    let (edge, dist) = nearest_edge(rect, area_t);
    if edge == Edge::Bottom { return; } // 底部是任务栏：贴边吸附即可，不躲藏
    let trigger = (DOCK_TRIGGER_LOGICAL as f64 * scale).round() as i32;
    if dist.abs() > trigger { return; }
    let sliver = (PEEK_SLIVER_LOGICAL as f64 * scale).round() as i32;
    let peeked = peek_position(edge, rect, area_t, sliver);
    let _ = pet.set_position(tauri::PhysicalPosition::new(peeked.0, peeked.1));
    if let Ok(mut st) = app.state::<Mutex<AutoDockState>>().lock() {
        st.peeked = Some(edge);
    }
}

/// 拖拽运动追踪：Moved 事件只在**边界**广播（开始一次/结束一次），
/// 每次移动都发事件会把 1Hz 的 IPC 变成 60Hz，前端反而被自己拖慢。
/// 结束判定靠"静默窗口"：原生拖动中 Moved 连续到达，停止移动 400ms 后视为放手。
#[derive(Default)]
struct DragMotion {
    dragging: bool,
    last_move_at: Option<std::time::Instant>,
    /// 松手前的位移采样（v0.12.0）：只保留最近 ~150ms，用来算"甩出去的速度"。
    /// 存时间戳而不是逐帧算速度，是因为速度要看整段位移/时长，单帧差值噪声太大。
    samples: VecDeque<(i32, i32, std::time::Instant)>,
    /// 惯性滑行中（v0.12.0）：这期间窗口会被我们自己 `set_position` 移动，
    /// 那些 `Moved` 事件必须忽略——否则会被当成"用户又抓住了"，把惯性打断成拖拽。
    inertia: bool,
    /// 程序性移动的抑制窗口（v0.29.1）：缩放/菜单扩窗/还原也会产生 `Moved`，
    /// 不抑制会被误判成拖拽（握持广播 + 400ms 后贴边/躲藏）。值为截止时刻。
    suppress_moves_until: Option<std::time::Instant>,
}

/// 标记接下来的窗口移动是程序性的（缩放/菜单扩窗/还原）：
/// 清空拖拽状态并打开 300ms 抑制窗，避免 `Moved` 被误判成用户拖拽。
fn suppress_programmatic_moves(app: &tauri::AppHandle) {
    let was_dragging = match app.state::<Mutex<DragMotion>>().lock() {
        Ok(mut motion) => {
            let was = motion.dragging;
            motion.dragging = false;
            motion.last_move_at = None;
            motion.samples.clear();
            motion.suppress_moves_until =
                Some(std::time::Instant::now() + Duration::from_millis(300));
            was
        }
        Err(_) => false,
    };
    // 锁外广播：握持姿态是前端状态，Rust 单方面清拖拽时要把它一起复位
    if was_dragging {
        let _ = app.emit_to("pet", EVT_PET_DRAG_CHANGED, serde_json::json!({ "dragging": false }));
    }
}

/// 惯性世代号：每次开始新惯性 +1。滑行线程持有自己的世代号，发现不匹配就立刻停下
/// （用户重新抓起宠物 = 世代号被 +1，比给线程发信号简单且无锁竞争）。
static INERTIA_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 达到这个速度（px/s）才会滑行。低于它直接吸附落地——轻放不该滑。
const INERTIA_MIN_SPEED: f64 = 250.0;
/// 每帧摩擦衰减（约 60fps）。0.88 下 250px/s 的初速滑行约 0.25 秒、60px。
const INERTIA_FRICTION: f64 = 0.88;
/// 速度低于这个值就停（px/s）：再滑就是"飘"，不是"滑"。
const INERTIA_STOP_SPEED: f64 = 40.0;
/// 单帧位移上限（px）：速度采样异常（跨屏跳变）时不让窗口瞬移。
const INERTIA_MAX_STEP: f64 = 120.0;
/// 滑行总时长上限：再长就失控了。
const INERTIA_MAX_MS: u64 = 600;
/// 惯性积分步长（ms）：16ms ≈ 60fps，与显示器刷新同步的常见值。
const INERTIA_STEP_MS: f64 = 16.0;

/// 从采样序列估算松手速度（px/s）。
///
/// 少于 2 个样本、或首尾时间差 <16ms 时返回 None——单点或极短窗口算出来的"速度"
/// 是抖动，据此滑行会变成随机弹射。
fn drag_velocity(samples: &VecDeque<(i32, i32, std::time::Instant)>) -> Option<(f64, f64)> {
    let first = samples.front()?;
    let last = samples.back()?;
    let seconds = last.2.duration_since(first.2).as_secs_f64();
    if seconds < 0.016 {
        return None;
    }
    Some((
        (last.0 - first.0) as f64 / seconds,
        (last.1 - first.1) as f64 / seconds,
    ))
}

/// 单帧惯性积分：返回 (新位置, 新速度, 是否结束)。纯函数，可单测。
///
/// 模型是**干摩擦 + 撞墙即停**，不是弹簧：
/// - 弹簧会有"回头"动作，桌宠被扔到边上还往回弹很离谱；
/// - 撞到工作区边缘直接把该轴速度清零，符合"放在边上就该停在那"的直觉；
/// - 位置同时被 clamp 在 work area 内，避免高速时穿出屏幕。
fn inertia_step(
    pos: (i32, i32),
    vel: (f64, f64),
    dt_ms: f64,
    size: (u32, u32),
    area: (i32, i32, u32, u32),
) -> ((i32, i32), (f64, f64), bool) {
    if !dt_ms.is_finite() || dt_ms <= 0.0 {
        return (pos, (0.0, 0.0), true);
    }
    let (ax, ay, aw, ah) = (area.0, area.1, area.2 as i32, area.3 as i32);
    let (w, h) = (size.0 as i32, size.1 as i32);
    // 工作区比窗口还小时，min == max，窗口会被钉在左上角（防御除零/负范围）
    let max_x = (ax + aw - w).max(ax);
    let max_y = (ay + ah - h).max(ay);

    let mut dx = vel.0 * dt_ms / 1000.0;
    let mut dy = vel.1 * dt_ms / 1000.0;
    let step = (dx * dx + dy * dy).sqrt();
    if step > INERTIA_MAX_STEP {
        let scale = INERTIA_MAX_STEP / step;
        dx *= scale;
        dy *= scale;
    }

    let mut next_x = pos.0 + dx.round() as i32;
    let mut next_y = pos.1 + dy.round() as i32;
    let mut next_vel = (vel.0 * INERTIA_FRICTION, vel.1 * INERTIA_FRICTION);

    if next_x <= ax {
        next_x = ax;
        next_vel.0 = 0.0;
    } else if next_x >= max_x {
        next_x = max_x;
        next_vel.0 = 0.0;
    }
    if next_y <= ay {
        next_y = ay;
        next_vel.1 = 0.0;
    } else if next_y >= max_y {
        next_y = max_y;
        next_vel.1 = 0.0;
    }

    let speed = (next_vel.0 * next_vel.0 + next_vel.1 * next_vel.1).sqrt();
    let moved = (next_x - pos.0).abs() + (next_y - pos.1).abs();
    ((next_x, next_y), next_vel, speed < INERTIA_STOP_SPEED || moved == 0)
}

/// 启动惯性滑行（v0.12.0）：后台线程按 60fps 积分，位置变更调回 UI 线程执行。
///
/// 为什么自己开线程而不是用现有 1s 原生节拍：1s 粒度做不出滑行，需要 ~16ms。
/// 线程只在"甩出去"的几百毫秒里存活，结束即退出，不做常驻。
fn start_inertia(app: tauri::AppHandle, velocity: (f64, f64)) {
    let token = INERTIA_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(state) = app.try_state::<Mutex<DragMotion>>() {
        if let Ok(mut motion) = state.lock() {
            motion.inertia = true;
        }
    }
    let handle = app.clone();
    let _ = std::thread::Builder::new().name("mochi-inertia".into()).spawn(move || {
        let Some(pet) = handle.get_webview_window("pet") else { finish_inertia(&handle); return };
        let (Ok(position), Ok(size)) = (pet.outer_position(), pet.outer_size()) else {
            finish_inertia(&handle);
            return;
        };
        let monitor = match pet.current_monitor() {
            Ok(Some(monitor)) => monitor,
            _ => match pet.primary_monitor() {
                Ok(Some(monitor)) => monitor,
                _ => {
                    finish_inertia(&handle);
                    return;
                }
            },
        };
        let area = monitor.work_area();
        let area_tuple = (area.position.x, area.position.y, area.size.width, area.size.height);
        let mut pos = (position.x, position.y);
        let mut vel = velocity;
        let started = std::time::Instant::now();

        loop {
            std::thread::sleep(Duration::from_millis(INERTIA_STEP_MS as u64));
            // 用户重新抓起（世代号变了）/ 应用退出：立刻停，不再动窗口
            if INERTIA_GENERATION.load(Ordering::SeqCst) != token {
                break;
            }
            let (next, next_vel, done) =
                inertia_step(pos, vel, INERTIA_STEP_MS, (size.width, size.height), area_tuple);
            pos = next;
            vel = next_vel;
            let mover = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                if let Some(pet) = mover.get_webview_window("pet") {
                    let _ = pet.set_position(tauri::PhysicalPosition::new(next.0, next.1));
                }
            });
            if done || started.elapsed() > Duration::from_millis(INERTIA_MAX_MS) {
                break;
            }
        }
        // 收尾也调回 UI 线程：保证它排在最后一批 set_position 之后，读到的位置才是最终位置
        let finisher = handle.clone();
        let _ = handle.run_on_main_thread(move || finish_inertia(&finisher));
    });
}

/// 惯性收尾：清标记与采样，再做一次贴边吸附（滑到边上正好对齐）。
fn finish_inertia(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Mutex<DragMotion>>() {
        if let Ok(mut motion) = state.lock() {
            motion.inertia = false;
            motion.samples.clear();
        }
    }
    snap_pet_to_edges(app);
}


/// 拖拽状态机（纯函数，可单测）：由「当前状态 + 距上次移动的毫秒数」决定广播。
/// 返回 Some(新的 dragging 值) = 需要广播；None = 无事发生。
fn drag_transition(dragging: bool, move_age_ms: Option<u64>) -> Option<bool> {
    if !dragging {
        return move_age_ms.is_some().then_some(true); // 首次 Moved → 开始拖拽
    }
    // 拖拽中：静默超过静默窗口才判定放手（400ms > 拖动中相邻 Moved 的间隔，
    // 即使帧率掉到 ~2.5fps 也不会误判；又远小于 1s 的原生节拍，放手反馈不迟钝）
    const DRAG_SETTLE_MS: u64 = 400;
    match move_age_ms {
        Some(age) if age >= DRAG_SETTLE_MS => Some(false),
        _ => None,
    }
}

/// 贴边吸附阈值（物理像素，v0.10.0）：24 物理 px 在 100%/150% 缩放下约 24/16 逻辑 px，
/// 正好是"看起来已经贴着了、还差一点点"的距离；再大就会在拖动过程中频繁跳位。
const SNAP_THRESHOLD_PX: i32 = 24;

/// 拖拽结束后把窗口贴到最近的工作区边缘（纯函数，可单测；坐标为物理像素）。
///
/// 只处理"接近"的情况：贴左/右各取较近的一侧，贴顶/底同理；离得远就保持用户
/// 放下的位置不动。**不做全局 clamp**——允许用户把宠物故意放在屏幕边上留一半，
/// 那是常见用法，强行拉回反而烦人。
fn snap_to_work_area(
    pos: (i32, i32),
    size: (u32, u32),
    area: (i32, i32, u32, u32),
    threshold: i32,
) -> (i32, i32) {
    let (x, y) = pos;
    let (w, h) = (size.0 as i32, size.1 as i32);
    let (ax, ay, aw, ah) = (area.0, area.1, area.2 as i32, area.3 as i32);
    let mut next_x = x;
    let mut next_y = y;
    if (x - ax).abs() <= threshold {
        next_x = ax;
    } else if ((ax + aw) - (x + w)).abs() <= threshold {
        next_x = ax + aw - w;
    }
    if (y - ay).abs() <= threshold {
        next_y = ay;
    } else if ((ay + ah) - (y + h)).abs() <= threshold {
        next_y = ay + ah - h;
    }
    (next_x, next_y)
}

/// 吸附当前宠物窗（拖拽收尾时调用）。取窗口所在显示器的工作区（已扣除任务栏），
/// 拿不到显示器就静默放弃——吸附是手感增强，不该因为枚举失败而影响拖拽本身。
fn snap_pet_to_edges(app: &tauri::AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else { return };
    let (Ok(position), Ok(size)) = (pet.outer_position(), pet.outer_size()) else { return };
    let monitor = match pet.current_monitor() {
        Ok(Some(monitor)) => monitor,
        _ => match pet.primary_monitor() {
            Ok(Some(monitor)) => monitor,
            _ => return,
        },
    };
    let area = monitor.work_area();
    let next = snap_to_work_area(
        (position.x, position.y),
        (size.width, size.height),
        (area.position.x, area.position.y, area.size.width, area.size.height),
        SNAP_THRESHOLD_PX,
    );
    if next != (position.x, position.y) {
        let _ = pet.set_position(tauri::PhysicalPosition::new(next.0, next.1));
    }
    // v0.29.1 修复：v0.29.0 的自动贴边判定（maybe_auto_dock）从未被调用——
    // 几何函数与开关都写好了，但拖拽收尾没有接线，功能实际是死代码。
    // 放在吸附之后：先把窗口贴到边缘，再按距边距离决定是否躲藏。
    maybe_auto_dock(app);
}

/// 应用入口：组装 Tauri Builder（插件 → 托盘 → 事件 → 窗口行为）后进入事件循环。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // panic=abort 意味着任何 Rust panic 都会让进程**无声消失**（托盘也没了）。
    // 先挂 panic 钩子：写进 {appData}/logs/（v0.16.0 起与常规日志同目录——用户/支持者
    // 找得到；旧版写临时目录，用户拿不到）。时机在 builder 之前，setup 前后的 panic
    // 都能覆盖；此时拿不到运行时配置，appData 路径按平台规则手动推导（见
    // app_data_dir_fallback），推导失败退回临时目录——有迹可循总比没有强。
    std::panic::set_hook(Box::new(|info| {
        let payload = info.to_string();
        let location = info.location().map_or("<unknown>".into(), |l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        let log = format!("[{}] [error] [panic] PANIC {location}\n{payload}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"));
        eprintln!("[mochi] {log}");
        // 脱敏兜底：panic 消息理论上是代码路径，但 payload 可能拼接任意运行时数据。
        let redacted = redact_message(&log);
        match app_data_dir_fallback().map(|p| p.join(LOG_DIR)) {
            Some(dir) => {
                if std::fs::create_dir_all(&dir).is_ok() {
                    // ① last-panic.txt：单文件覆盖写——「关于」页读它显示上次崩溃摘要
                    let _ = std::fs::write(dir.join(LAST_PANIC_FILE), redacted.as_bytes());
                    // ② 当天日志也留痕：排障时一个目录看全（含崩溃前的常规日志）
                    append_log_line_at(&dir, "error", "panic", &log);
                }
            }
            None => {
                let path = std::env::temp_dir().join("mochi-panic.log");
                if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                    use std::io::Write as _;
                    let _ = file.write_all(redacted.as_bytes());
                }
            }
        }
    }));

    // single-instance 必须最先注册：第二次启动进程时，回调在「已有实例」里执行
    let builder = tauri::Builder::default()
        .manage(Mutex::new(AlertQueue::default()))
        .manage(Mutex::new(DragMotion::default()))
        .manage(Mutex::new(PetHitTest::default()))
        .manage(Mutex::new(GameMode::default()))
        .manage(Mutex::new(AutoDockState::default()))
        .manage(Mutex::new(PetMenuSpace::default()))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 用户再次双击图标：把已有宠物的窗口唤回前台。窗口可能在创建中
            // （初始化早期再次双击）——短重试兜底，避免"点了图标却什么都没发生"。
            for attempt in 0..3 {
                match app.get_webview_window("pet") {
                    Some(pet) => {
                        let _ = pet.show();
                        return;
                    }
                    None if attempt < 2 => std::thread::sleep(Duration::from_millis(600)),
                    None => {
                        eprintln!("[single-instance] 宠物窗口尚未就绪，唤起失败");
                        append_log_line(app, "error", "single-instance", "二次启动唤起失败：宠物窗口尚未就绪");
                    }
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // store：settings.json 等 KV 持久化（API Key 只存这里，禁止入日志/仓库——AGENTS.md）
        .plugin(tauri_plugin_store::Builder::default().build())
        // sql：SQLite（mochi.db，四表 DDL 由 TS 侧 ensureSchema 幂等创建——见 src/services/db.ts）
        .plugin(
            tauri_plugin_sql::Builder::default()
                .build(),
        )
        // notification：系统通知（站立提醒/番茄钟/自定义提醒）
        .plugin(tauri_plugin_notification::init())
        // window-state：窗口位置持久化（v0.9.0 P0-04）——拖到哪下次启动就在哪。
        // 只持久化位置（POSITION）：见 Cargo.toml 注释，VISIBLE 会破坏 chat 的
        // 「隐藏启动」设计。恢复时机：本插件在窗口创建时自动恢复，setup 里
        // ensure_pet_position 再显式恢复一次 + 做可见性校验（双保险，时序确定）
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .build(),
        )
        // global-shortcut：全局快捷键（P1-13）。注册在 Rust 侧（register_chat_shortcut），
        // 插件本身只提供机制；前端经 state://shortcut-changed 开关
        .plugin(tauri_plugin_global_shortcut::Builder::default().build())
        // autostart：开机自启（P1-14）。默认关（设置开关驱动，不默认自启是底线）；
        // macOS 走 LaunchAgent（默认 launcher）
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            list_user_pet_assets, get_idle_seconds,
            show_app_alert, get_app_alert, ack_app_alert, dismiss_app_alert,
            set_pet_hit_test, get_autostart_enabled, save_pet_asset, delete_user_pet_asset,
            export_pet_assets, prepare_pet_menu, restore_pet_menu,
            append_log, get_last_panic,
            export_backup, list_backups, import_backup
        ]);

    builder
        .setup(|app| {
            // Tauri 2 的 activation policy 属于 App，而不是 Builder；仅 macOS 提供。
            // 在 setup 拿到 App 后设置 Accessory，才能跨平台编译并隐藏 Dock 图标
            // （v0.8.1 修复：旧 Builder 链式写法在 macOS 编译失败）。
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            setup_tray(app)?;
            setup_ui_event_listeners(app.handle().clone());
            // v0.16.0：启动时清理过期日志（保留 7 天）。readdir 十几个文件的量级，
            // 一次性同步可接受；不在 native tick 里做（任务单的坑）。
            if let Some(dir) = log_dir(app.handle()) {
                cleanup_old_logs(&dir);
            }
            // v0.9.0 P0-04：先恢复持久化位置 + 可见性校验，失败回退右下角默认位
            ensure_pet_position(app);
            // v0.8.2：原生节拍——隐藏窗口时 WebView 的 setInterval 会被节流
            start_native_tick(app.handle().clone());
            // v0.9.0 桌宠体检：透明区域点击穿透的唤回轮询（穿透时 WebView 失明，靠它召回）
            start_pet_hit_test_poll(app.handle().clone());
            Ok(())
        })
        // 拦截所有窗口的关闭请求 → 隐藏。Tauri 中窗口关闭默认会销毁窗口对象，
        // 隐藏则保留对象，之后 show() 零成本恢复（状态都在）。
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if window.label() == "alert" {
                        // Alt+F4 也确认当前提醒；单纯 hide 会留下一个永不再显示的队头。
                        let app = window.app_handle().clone();
                        if let Ok(Some(current)) = get_app_alert(app.clone()) {
                            let _ = ack_app_alert(app, current.id);
                        } else {
                            let _ = window.hide();
                        }
                    } else {
                        let _ = window.hide();
                    }
                }
                // 宠物窗被拖动（原生 start_dragging 中 Moved 连续到达）：只在边界广播
                // 「开始拖拽」，结束由 native tick 的静默窗口判定（见 DragMotion 注释）。
                WindowEvent::Moved(position) if window.label() == "pet" => {
                    let app = window.app_handle().clone();
                    let state = app.state::<Mutex<DragMotion>>();
                    let mut motion = match state.lock() {
                        Ok(m) => m,
                        Err(_) => return, // 锁中毒：拖拽反馈是锦上添花，静默跳过
                    };
                    let now = std::time::Instant::now();
                    // 惯性滑行 / 程序性移动（缩放、菜单扩窗）期间窗口是我们自己在动：
                    // 这些事件既不该刷新"拖拽静默窗口"，也不该被当成新一趟拖拽。
                    if motion.inertia {
                        return;
                    }
                    if motion.suppress_moves_until.is_some_and(|until| now < until) {
                        return;
                    }
                    motion.last_move_at = Some(now);
                    if let Some(next) = drag_transition(motion.dragging, Some(0)) {
                        motion.dragging = next;
                        if next {
                            motion.samples.clear(); // 新一趟拖拽：丢掉上一趟的采样
                        }
                        let _ = app.emit_to("pet", EVT_PET_DRAG_CHANGED, serde_json::json!({ "dragging": next }));
                    }
                    // 采样只在拖拽中收集；保留最近 8 个且不超过 150ms——够算速度，又不吃内存
                    motion.samples.push_back((position.x, position.y, now));
                    while motion.samples.len() > 8 {
                        motion.samples.pop_front();
                    }
                    while let Some(front) = motion.samples.front() {
                        if now.duration_since(front.2).as_millis() > 150 {
                            motion.samples.pop_front();
                        } else {
                            break;
                        }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("Mochi 启动失败");
}

/// 构建托盘：图标 + 右键菜单 + 左键单击切换宠物显示。
/// tooltip 由前端事件驱动动态更新（set_tray_tooltip），菜单动作反向 emit 给
/// 宠物窗 Service（state://pomodoro-start 等，P1-03）。
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    // 菜单项三要素：id（事件分发用）、文案、是否可用；第四参是快捷键（暂无）
    // 命名注意：局部变量不能与下方 toggle_pet() 函数同名，否则遮蔽导致 E0618
    let toggle_item = MenuItem::with_id(app, "toggle-pet", "显示 / 隐藏麻薯", true, None::<&str>)?;
    let open_chat = MenuItem::with_id(app, "open-chat", "打开聊天", true, None::<&str>)?;
    let open_settings = MenuItem::with_id(app, "open-settings", "设置…", true, None::<&str>)?;
    let pomodoro_start = MenuItem::with_id(app, "start-pomodoro", "开始番茄钟", true, None::<&str>)?;
    let pomodoro_stop = MenuItem::with_id(app, "stop-pomodoro", "停止番茄钟", true, None::<&str>)?;
    let snooze = MenuItem::with_id(app, "snooze-standup", "暂停站立提醒 1 小时", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Mochi", true, None::<&str>)?;
    let sep1 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let sep2 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let sep3 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&toggle_item, &open_chat, &open_settings, &sep1, &pomodoro_start, &pomodoro_stop, &sep2, &snooze, &sep3, &quit],
    )?;

    // tooltip 缓存：状态没变就不调 set_tooltip（番茄钟每秒广播一次，不去重会
    // 每秒写一次 NOTIFYICONDATA——不是不能做，是没必要）
    app.manage(std::sync::Mutex::new("Mochi 麻薯".to_string()));

    // 图标兜底（桌宠体检）：default_window_icon 来自打包配置，缺失不该 panic——
    // panic=abort 下会整个进程消失。托盘没图标退回系统默认，功能不受损。
    let tray_builder = TrayIconBuilder::with_id("mochi-tray")
        .tooltip("Mochi 麻薯")
        .menu(&menu);
    let tray_builder = match app.default_window_icon().cloned() {
        Some(icon) => tray_builder.icon(icon),
        None => {
            eprintln!("[tray] 缺少应用图标，托盘使用系统默认图标");
            append_log_line(app.handle(), "warn", "tray", "缺少应用图标，托盘使用系统默认图标");
            tray_builder
        }
    };
    tray_builder
        // Windows 默认左键弹出菜单；关掉它，把左键留给「切换宠物」，
        // 菜单走右键（桌面助手类软件的通行交互）
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            // 只响应「左键抬起」= 单击语义；按下/双击等事件全部忽略
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_pet(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle-pet" => toggle_pet(app),
            "open-chat" => {
                show_chat(app);
            }
            // 设置…：直达设置 Tab（复用 open-chat 的 {tab} 载荷转发，P1-02）
            "open-settings" => {
                show_chat(app);
                if let Some(chat) = app.get_webview_window("chat") {
                    let _ = chat.emit(EVT_CHAT_OPEN, "{\"tab\":\"settings\"}");
                }
            }
            // 托盘 → 宠物窗 Service：沿用 chat 窗遥控番茄钟的 state:// 先例
            "start-pomodoro" => {
                let _ = app.emit(EVT_POMODORO_START, serde_json::json!({}));
            }
            "stop-pomodoro" => {
                let _ = app.emit(EVT_POMODORO_STOP, serde_json::json!({}));
            }
            "snooze-standup" => {
                let _ = app.emit(EVT_STANDUP_SNOOZE, serde_json::json!({ "minutes": 60 }));
                set_tray_tooltip(app, "Mochi 麻薯"); // 暂停 = 退出「该站起来了」态
            }
            "quit" => app.exit(0), // 唯一的真正退出入口（绕过窗口 hide 拦截）
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// 更新托盘 tooltip（内容不变则跳过；缓存为 Mutex<String>，见 setup_tray）
fn set_tray_tooltip(app: &tauri::AppHandle, text: &str) {
    let Some(cache) = app.try_state::<std::sync::Mutex<String>>() else {
        return;
    };
    // 锁中毒不致命：Mutex<String> 的内容在 panic 后依然有效，恢复所有权继续用，
    // 绝不让托盘更新变成第二个 panic（panic=abort 下会连锁杀掉整个进程）。
    let mut last = match cache.lock() {
        Ok(l) => l,
        Err(poisoned) => poisoned.into_inner(),
    };
    if *last == text {
        return;
    }
    if let Some(tray) = app.tray_by_id("mochi-tray") {
        let _ = tray.set_tooltip(Some(text));
        *last = text.to_string();
    }
}

/// 注册/注销全局快捷键（P1-13）。开关切换与启动应用共用此入口；
/// 先 unregister 再 register 保证幂等（重复注册同键会 Err）。
/// 键位被占用（其他软件先注册了）：静默降级——应用功能不受影响，仅把
/// registered=false 回传设置页提示（施工单：失败不弹错误框）。
fn register_chat_shortcut(app: &tauri::AppHandle, enabled: bool) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let gs = app.global_shortcut();
    let _ = gs.unregister(SHORTCUT_CHAT);
    if !enabled {
        let _ = app.emit(EVT_SHORTCUT_STATE, serde_json::json!({ "enabled": false, "registered": false }));
        return;
    }
    let result = gs.on_shortcut(SHORTCUT_CHAT, |app, _shortcut, event| {
        // 只响应按下沿（Released 忽略）：触发一次即开聊天窗
        if event.state() == ShortcutState::Pressed {
            show_chat(app);
        }
    });
    let registered = result.is_ok();
    if let Err(e) = result {
        eprintln!("[shortcut] 注册失败（可能被占用）: {e}");
        append_log_line(app, "warn", "shortcut", &format!("快捷键注册失败（可能被占用）: {e}"));
    }
    let _ = app.emit(EVT_SHORTCUT_STATE, serde_json::json!({ "enabled": true, "registered": registered }));
}

/// 注册前端 → Rust 的 UI 事件监听。
/// `listen_any` 监听全局广播事件（前端 `emit()` 发出的事件所有监听者可见）。
fn setup_ui_event_listeners(app: tauri::AppHandle) {
    // 闭包需要持有自己的 AppHandle 副本（'static 生命周期要求）
    // open-chat：显示聊天窗，并把 {tab} 载荷原样转发给 chat 窗（P1-02 直达 Tab）
    let handle = app.clone();
    app.listen_any(EVT_OPEN_CHAT, move |event| {
        show_chat(&handle);
        if let Some(chat) = handle.get_webview_window("chat") {
            let _ = chat.emit(EVT_CHAT_OPEN, event.payload());
        }
    });

    let handle = app.clone();
    app.listen_any(EVT_HIDE_CHAT, move |_| {
        if let Some(chat) = handle.get_webview_window("chat") {
            let _ = chat.hide();
        }
    });

    let handle = app.clone();
    app.listen_any(EVT_TOGGLE_PET, move |_| toggle_pet(&handle));

    // 只有前端手势已越过移动阈值才进原生拖动，单击/双击不再被 mousedown 抢走。
    // v0.12.0：抓住宠物立即取消进行中的惯性（世代号 +1，滑行线程下一帧自行退出）。
    let handle = app.clone();
    app.listen_any(EVT_DRAG_PET, move |_| {
        INERTIA_GENERATION.fetch_add(1, Ordering::SeqCst);
        // 抓起宠物即取消躲藏判定（v0.29.0）：松手后重新评估贴边/躲藏
        if let Ok(mut st) = handle.state::<Mutex<AutoDockState>>().lock() {
            st.peeked = None;
        }
        let state = handle.state::<Mutex<DragMotion>>();
        if let Ok(mut motion) = state.lock() {
            motion.inertia = false;
            motion.samples.clear();
        }
        if let Some(pet) = handle.get_webview_window("pet") {
            let _ = pet.start_dragging();
        }
    });

    // 右键菜单「退出」（托盘菜单直接调 app.exit，不走事件）
    let handle = app.clone();
    app.listen_any(EVT_QUIT_APP, move |_| handle.exit(0));

    // 快捷键开关（P1-13）：前端设置页切换 / 启动时按 settings 应用
    let handle = app.clone();
    app.listen_any(EVT_SHORTCUT_CHANGED, move |event| {
        let enabled = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("enabled").and_then(|b| b.as_bool()))
            .unwrap_or(false);
        register_chat_shortcut(&handle, enabled);
    });

    // 宠物大小（P1-15）：Rust 改窗口尺寸（保持右下角锚点 + 屏内 clamp）；
    // 宠物窗自己监听同一事件把档位写进 CSS 变量
    let handle = app.clone();
    app.listen_any(EVT_PET_SCALE_CHANGED, move |event| {
        let scale = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("scale").and_then(|s| s.as_f64()))
            .unwrap_or(1.0);
        apply_pet_scale(&handle, scale);
    });

    // 开机自启开关（P1-14）：设置是事实源，Rust 只执行系统项变更；
    // 失败 eprintln 不弹窗（系统能力缺失时自启本来就不可能，开关下次启动可重试）
    let handle = app.clone();
    app.listen_any(EVT_AUTOSTART_CHANGED, move |event| {
        use tauri_plugin_autostart::ManagerExt as _;
        let enabled = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("enabled").and_then(|b| b.as_bool()))
            .unwrap_or(false);
        let result = if enabled {
            handle.autolaunch().enable()
        } else {
            handle.autolaunch().disable()
        };
        // 回执读系统真值（v0.9.1）：注册表被安全软件回滚时 enable() 仍是 Ok，
        // 只有 is_enabled() 才代表"下次开机会真的启动"。读取失败按"未生效"处理——
        // 宁可让用户看到提示，也不要给出假成功。
        let actual = handle.autolaunch().is_enabled().unwrap_or(false);
        let error = match result {
            Ok(()) if actual == enabled => None,
            Ok(()) => Some(if enabled {
                "系统没有保留这次修改（可能被安全软件的启动项防护拦下了）".to_string()
            } else {
                "系统里还留着启动项，可能被安全软件的启动项防护锁定了".to_string()
            }),
            Err(e) => Some(e.to_string()),
        };
        if let Some(msg) = &error {
            eprintln!("[autostart] 应用失败: {msg}");
            append_log_line(&handle, "error", "autostart", &format!("自启项应用失败: {msg}"));
        }
        // 广播的是 actual（系统真值）而不是用户点的值：UI 据此判断是否"错位"。
        let _ = handle.emit(
            EVT_AUTOSTART_STATE,
            serde_json::json!({
                "enabled": actual,
                "ok": error.is_none(),
                "error": error,
            }),
        );
    });

    // 自动贴边开关（v0.29.0）：同步 enabled；关闭时立即从躲藏恢复完整显示
    let handle = app.clone();
    app.listen_any(EVT_AUTO_DOCK_CHANGED, move |event| {
        let enabled = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("enabled").and_then(|b| b.as_bool()))
            .unwrap_or(false);
        let (restore,) = {
            let state = handle.state::<Mutex<AutoDockState>>();
            match state.lock() {
                Ok(mut st) => {
                    st.enabled = enabled;
                    (st.peeked.is_some() && !enabled,)
                }
                Err(_) => (false,),
            }
        };
        if restore {
            restore_from_peek(&handle);
        }
    });

    // 游戏模式开关（v0.9.0 自迭代）：只置标志位，检测在 native tick 里做（1s 节奏，
    // 不加线程）；切换开关时若宠物因旧会话被隐藏，先恢复，避免状态悬挂。
    let handle = app.clone();
    app.listen_any(EVT_GAME_MODE_CHANGED, move |event| {
        let enabled = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("enabled").and_then(|b| b.as_bool()))
            .unwrap_or(false);
        let state = handle.state::<Mutex<GameMode>>();
        if let Ok(mut mode) = state.lock() {
            mode.enabled = enabled;
            if !enabled && mode.hidden_by_gm {
                mode.hidden_by_gm = false;
                if let Some(pet) = handle.get_webview_window("pet") {
                    let _ = pet.show();
                }
            }
        }
    });

    // 旧入口兼容：v0.7.0 的无 id 弹窗显示事件。托盘 tooltip 切到「该站起来了」
    // （P1-03）；正文提醒的真实通道是 show_app_alert 命令 + 队列。
    let handle = app.clone();
    app.listen_any(EVT_SHOW_ALERT, move |_| {
        set_tray_tooltip(&handle, "Mochi · 该站起来了");
        show_alert(&handle);
    });

    // 服务端超时/重置也可收起弹窗，不能依赖用户一定会点击弹窗。
    // 收尾不等于确认：不触发 standup-ack 的副作用（P1-11「稍后」语义）。
    let handle = app.clone();
    app.listen_any(EVT_HIDE_ALERT, move |_| {
        hide_legacy_alert(&handle);
        set_tray_tooltip(&handle, "Mochi 麻薯");
    });

    let handle = app.clone();
    app.listen_any(EVT_STANDUP_ACK, move |_| {
        hide_legacy_alert(&handle);
        set_tray_tooltip(&handle, "Mochi 麻薯");
    });

    // 原生提醒队列变化（v0.8.2）→ 托盘 tooltip：站立提醒弹出即提示，
    // 队列清空回默认。载荷为 Option<AppAlert>（null = 队列空）。
    let handle = app.clone();
    app.listen_any(EVT_ALERT_CHANGED, move |event| {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        let kind = v.get("kind").and_then(|k| k.as_str());
        match kind {
            Some("standup") => set_tray_tooltip(&handle, "Mochi · 该站起来了"),
            _ => set_tray_tooltip(&handle, "Mochi 麻薯"),
        }
    });

    // 番茄钟状态 → tooltip（P1-03）：focus/break 显示倒计时，idle 回默认。
    // 载荷解析失败静默跳过（tooltip 只丢一次更新，下秒的广播会补上）
    let handle = app.clone();
    app.listen_any(EVT_POMODORO_CHANGED, move |event| {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        let phase = v.get("phase").and_then(|p| p.as_str()).unwrap_or("idle");
        let text = match phase {
            "focus" | "break" => {
                let label = if phase == "focus" { "专注中" } else { "休息中" };
                match v.get("remainingSec").and_then(|s| s.as_u64()) {
                    Some(sec) => format!("Mochi · {label} {:02}:{:02}", sec / 60, sec % 60),
                    None => format!("Mochi · {label}"),
                }
            }
            _ => "Mochi 麻薯".to_string(),
        };
        set_tray_tooltip(&handle, &text);
    });
}

/// 把提醒弹窗显示到宠物正上方居中处（learning/08 §4.2）。
/// 几何都取物理像素：宠物位置/尺寸 + 弹窗 outer_size。
fn show_alert(app: &tauri::AppHandle) {
    let _ = position_and_show_alert(app);
}

/// 兼容旧无 id 事件，但它们不能隐藏新队列里属于另一个服务的提醒。
fn hide_legacy_alert(app: &tauri::AppHandle) {
    if matches!(get_app_alert(app.clone()), Ok(None)) {
        if let Some(alert) = app.get_webview_window("alert") { let _ = alert.hide(); }
    }
}

/// 工作区含显示器原点与任务栏边界；不能只按主屏尺寸计算，否则负坐标屏/贴边会丢弹窗。
fn position_and_show_alert(app: &tauri::AppHandle) -> Result<(), String> {
    let alert = app.get_webview_window("alert").ok_or("提醒窗口不存在")?;
    let pet = app.get_webview_window("pet").ok_or("宠物窗口不存在")?;
    let monitor = match pet.current_monitor().map_err(|e| e.to_string())? {
        Some(monitor) => monitor,
        None => pet.primary_monitor().map_err(|e| e.to_string())?.ok_or("显示器不可用")?,
    };
    let area = monitor.work_area();
    let pet_pos = pet.outer_position().map_err(|e| e.to_string())?;
    let pet_size = pet.outer_size().map_err(|e| e.to_string())?;
    let alert_size = alert.outer_size().map_err(|e| e.to_string())?;
    let (x, y) = alert_position(
        (pet_pos.x, pet_pos.y), (pet_size.width, pet_size.height),
        (alert_size.width, alert_size.height),
        (area.position.x, area.position.y, area.size.width, area.size.height),
    );
    alert.set_position(tauri::PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    // 不 set_focus：到点提示不能抢走用户正在输入的焦点。
    alert.show().map_err(|e| e.to_string())
}

/// 纯几何函数让跨屏、顶边和任务栏边界可独立测试，计算统一使用物理像素。
fn alert_position(pet: (i32, i32), pet_size: (u32, u32), size: (u32, u32), area: (i32, i32, u32, u32)) -> (i32, i32) {
    let left = area.0 as i64;
    let top = area.1 as i64;
    let right = left + area.2 as i64;
    let bottom = top + area.3 as i64;
    let x = pet.0 as i64 + (pet_size.0 as i64 - size.0 as i64) / 2;
    let above = pet.1 as i64 - size.1 as i64 - 12;
    let y = if above < top { pet.1 as i64 + pet_size.1 as i64 + 12 } else { above };
    (x.clamp(left, (right - size.0 as i64).max(left)) as i32,
     y.clamp(top, (bottom - size.1 as i64).max(top)) as i32)
}

/// 先发布内容再显示窗口。失败保留 needs_present，由下一个原生 tick 重试。
fn present_alert(app: &tauri::AppHandle, queue: &mut AlertQueue) -> Result<(), String> {
    queue.needs_present = true;
    app.emit_to("alert", EVT_ALERT_CHANGED, queue.items.front().cloned()).map_err(|e| e.to_string())?;
    if queue.items.is_empty() {
        app.get_webview_window("alert").ok_or("提醒窗口不存在")?.hide().map_err(|e| e.to_string())?;
    } else {
        position_and_show_alert(app)?;
    }
    queue.needs_present = false;
    Ok(())
}

/// 接受队列才返回成功；首条显示失败则回滚，让 TS 调度器保留可重试记录。
#[tauri::command]
fn show_app_alert(app: tauri::AppHandle, alert: AppAlert) -> Result<(), String> {
    if alert.id.trim().is_empty() || alert.title.trim().is_empty() || alert.body.trim().is_empty() {
        return Err("提醒内容不能为空".into());
    }
    // 提醒唤回（v0.29.0）：有提醒就恢复完整显示——躲藏时不能错过提醒
    restore_from_peek(&app);
    let state = app.state::<Mutex<AlertQueue>>();
    let mut queue = state.lock().map_err(|_| "提醒队列不可用")?;
    let was_empty = queue.items.is_empty();
    if !queue.enqueue(alert) { return Ok(()); }
    if was_empty {
        if let Err(error) = present_alert(&app, &mut queue) {
            queue.items.pop_front();
            let _ = present_alert(&app, &mut queue);
            return Err(error);
        }
    }
    Ok(())
}

/// Alert WebView 可能尚未监听 ready；提供快照，避免丢失首次显示内容。
#[tauri::command]
fn get_app_alert(app: tauri::AppHandle) -> Result<Option<AppAlert>, String> {
    let state = app.state::<Mutex<AlertQueue>>();
    let queue = state.lock().map_err(|_| "提醒队列不可用")?;
    Ok(queue.items.front().cloned())
}

/// 只确认当前 id。旧 DOM 的连续点击不能把刚排上来的下一条也关闭。
#[tauri::command]
fn ack_app_alert(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<Mutex<AlertQueue>>();
    let mut queue = state.lock().map_err(|_| "提醒队列不可用")?;
    let Some(current) = queue.items.front() else { return Ok(()); };
    if current.id != id { return Ok(()); }
    let ack = AlertAck { id: current.id.clone(), kind: current.kind.clone() };
    app.emit(EVT_ALERT_ACKED, ack).map_err(|e| e.to_string())?;
    queue.acknowledge(&id);
    // 当前确认已完成；下一条的临时显示故障由 heartbeat 重试，不撤销本次确认。
    let _ = present_alert(&app, &mut queue);
    Ok(())
}

/// 自动收尾/取消仅移除所属 id，不发送“用户确认”，避免误重置站立计时。
#[tauri::command]
fn dismiss_app_alert(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<Mutex<AlertQueue>>();
    let mut queue = state.lock().map_err(|_| "提醒队列不可用")?;
    let was_current = queue.dismiss(&id);
    if was_current { present_alert(&app, &mut queue)?; }
    Ok(())
}

/// 原生脉冲不依赖后台 WebView 的 setInterval；业务仍按 epoch 截止时间幂等判断。
/// 顺带承担拖拽结束判定（DragMotion 静默窗口）：不加线程，零额外成本。
/// 会话是否处于锁屏 / UAC 安全桌面（v0.11.0）。
///
/// 判据：`GetForegroundWindow()` 返回无效句柄——锁屏与安全桌面下系统不给前台窗口。
/// 这是**启发式**，并且刻意只问"有没有前台窗口"，不读标题、进程名或内容
/// （learning/08 §3 隐私红线的延续）。误判代价很小：把"在场"判成"离开"，
/// 用户回来一有输入就自愈；把"离开"判成"在场"则会漏掉一次抑制，都不致命。
#[cfg(windows)]
fn session_locked() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    // SAFETY: 纯查询调用，无参数、无副作用、不持有资源。
    unsafe { GetForegroundWindow().is_invalid() }
}

#[cfg(not(windows))]
fn session_locked() -> bool {
    false
}

fn start_native_tick(app: tauri::AppHandle) {
    // 上一拍的时刻（v0.11.0）：线程 sleep 被系统挂起时 elapsed 会远大于 1s，
    // 这是前端**唯一可靠的"刚从休眠恢复"信号**——JS 的 setInterval 在休眠期间
    // 根本不执行，醒来也不会告诉你少跑了多久。
    let mut last_tick = std::time::Instant::now();
    let _ = std::thread::Builder::new().name("mochi-clock".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let gap_ms = last_tick.elapsed().as_millis() as u64;
        last_tick = std::time::Instant::now();
        let handle = app.clone();
        // 窗口副作用统一调回 UI 线程，避免后台持锁等待窗口线程时与同步命令形成死锁。
        let _ = app.run_on_main_thread(move || {
            // 载荷 { gap_ms, locked }：前端据此判定"恢复"与"锁屏"（见 services/system-events.ts）。
            // 旧版载荷是 ()，两个订阅方（heartbeat / 首启兜底重放）都不读载荷，改动向后兼容。
            let _ = handle.emit_to(
                "pet",
                EVT_NATIVE_TICK,
                serde_json::json!({ "gap_ms": gap_ms, "locked": session_locked() }),
            );
            let state = handle.state::<Mutex<AlertQueue>>();
            if let Ok(mut queue) = state.lock() {
                if queue.needs_present { let _ = present_alert(&handle, &mut queue); }
            };
            // 拖拽收尾：上次 Moved 静默超窗 → 广播「放下」+ 贴边吸附（v0.10.0）。
            // 锁的作用域收紧到"只算状态"：窗口 API（get/set_position）在锁外调用——
            // 持锁调 UI 线程是本文件开头警告过的死锁形态。
            // 松手：算出"甩出去"的速度，决定滑行还是直接落地（v0.12.0）。
            // 外层 Option = 这一拍是否发生"放手"；内层 Option = 是否采到可用速度。
            let dropped_velocity = {
                let drag_state = handle.state::<Mutex<DragMotion>>();
                match drag_state.lock() {
                    Ok(mut motion) => {
                        let age = motion.last_move_at.map(|t| t.elapsed().as_millis() as u64);
                        match drag_transition(motion.dragging, age) {
                            Some(false) => {
                                motion.dragging = false;
                                motion.last_move_at = None;
                                let velocity = drag_velocity(&motion.samples);
                                motion.samples.clear(); // 采样只服务于这一次松手
                                Some(velocity)
                            }
                            Some(true) => {
                                motion.dragging = true;
                                None
                            }
                            None => None,
                        }
                    }
                    Err(_) => None, // 锁中毒：拖拽反馈是锦上添花，静默跳过
                }
            };
            if let Some(velocity) = dropped_velocity {
                let _ = handle.emit_to("pet", EVT_PET_DRAG_CHANGED, serde_json::json!({ "dragging": false }));
                match velocity {
                    Some((vx, vy)) if (vx * vx + vy * vy).sqrt() >= INERTIA_MIN_SPEED => {
                        // 甩得够快：先滑行，滑完由 finish_inertia 贴边
                        start_inertia(handle.clone(), (vx, vy));
                    }
                    _ => snap_pet_to_edges(&handle), // 轻放：直接吸附落地
                }
            }
            // 游戏模式（v0.9.0 自迭代）：默认关；开启时 1s 节奏检测前台全屏。
            // 只在"遮挡宠物所在屏"时隐藏，退出全屏恢复——不碰用户手动 toggle 的状态
            // （hidden_by_gm 只标记本功能自己的隐藏）。
            let gm_state = handle.state::<Mutex<GameMode>>();
            if let Ok(mut mode) = gm_state.lock() {
                if !mode.enabled {
                    return;
                }
                #[cfg(windows)]
                {
                    match foreground_fullscreen_monitor() {
                        Some(monitor) => {
                            let occluded = pet_on_monitor(&handle, &monitor);
                            if occluded && !mode.hidden_by_gm {
                                mode.hidden_by_gm = true;
                                if let Some(pet) = handle.get_webview_window("pet") {
                                    let _ = pet.hide();
                                }
                            } else if !occluded && mode.hidden_by_gm {
                                mode.hidden_by_gm = false;
                                if let Some(pet) = handle.get_webview_window("pet") {
                                    let _ = pet.show();
                                }
                            }
                        }
                        None if mode.hidden_by_gm => {
                            mode.hidden_by_gm = false;
                            if let Some(pet) = handle.get_webview_window("pet") {
                                let _ = pet.show();
                            }
                        }
                        None => {}
                    }
                }
            }
        });
    });
}

/// 点击穿透命令（v0.9.0 桌宠体检）：JS 命中检测到指针在透明区域时调用。
/// 幂等去重（重复同值调用直接返回），JS 上报的形象矩形存进状态供唤回轮询使用。
#[tauri::command]
fn set_pet_hit_test(
    app: tauri::AppHandle,
    ignore: bool,
    x: f64, y: f64, width: f64, height: f64,
) -> Result<(), String> {
    let state = app.state::<Mutex<PetHitTest>>();
    let mut hit = state.lock().map_err(|_| "命中检测状态不可用")?;
    hit.sprite = Some((x, y, width, height));
    if hit.ignore == ignore {
        return Ok(()); // 去重：每次 pointermove 都会调用，不重复切穿透态
    }
    hit.ignore = ignore;
    if let Some(pet) = app.get_webview_window("pet") {
        pet.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 穿透态唤回轮询：ignore=true 时 WebView 收不到指针事件，JS 无法自行恢复——
/// 由这条 150ms 线程轮询全局光标，重新进入形象矩形就恢复事件接收。
/// 仅在穿透态工作（常态直接 continue），几乎零成本。
fn start_pet_hit_test_poll(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new().name("mochi-hitpoll".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_millis(150));
        // 躲藏唤回（v0.29.0）：peek 状态下光标进入贴边唤回带 → 恢复停靠位
        {
            let peeked = app.state::<Mutex<AutoDockState>>().lock().ok().and_then(|st| st.peeked);
            if let Some(edge) = peeked {
                if let Ok(cursor) = app.cursor_position() {
                    let wake = (PEEK_WAKE_ZONE_LOGICAL as f64) as i32;
                    let cursor_i = (cursor.x as i32, cursor.y as i32);
                    if let Some(pet) = app.get_webview_window("pet") {
                        let (Ok(pos), Ok(size)) = (pet.outer_position(), pet.outer_size()) else { continue; };
                        if let Ok(Some(monitor)) = pet.current_monitor() {
                            let area = monitor.work_area();
                            if cursor_wakes_peek(cursor_i, edge, (pos.x, pos.y, size.width as i32, size.height as i32), (area.position.x, area.position.y, area.size.width as i32, area.size.height as i32), wake) {
                                restore_from_peek(&app);
                                continue;
                            }
                        }
                    }
                }
            }
        }
        let state = app.state::<Mutex<PetHitTest>>();
        let (ignore, sprite) = match state.lock() {
            Ok(h) => (h.ignore, h.sprite),
            Err(_) => continue,
        };
        if !ignore {
            continue;
        }
        let Some(sprite) = sprite else { continue };
        let Some(pet) = app.get_webview_window("pet") else { continue };
        let Ok(window_pos) = pet.outer_position().map(|p| (p.x as f64, p.y as f64)) else { continue };
        // 窗口**当前所在显示器**的 DPI（v0.25.0：混合双屏下 primary 与 current 的
        // scale factor 可能不同，用主屏换算会让命中余量偏大/偏小）。拿不到按 1.0 算。
        let scale = match pet.current_monitor() {
            Ok(Some(m)) => m.scale_factor(),
            _ => pet.primary_monitor().ok().flatten().map_or(1.0, |m| m.scale_factor()),
        };
        let cursor = match app.cursor_position() {
            Ok(c) => (c.x, c.y),
            Err(_) => continue,
        };
        if cursor_hits_sprite(cursor, window_pos, scale, sprite, 8.0) {
            // 光标回到形象上：恢复事件接收。锁失败静默——下一次轮询重试。
            if let Ok(mut hit) = state.lock() {
                hit.ignore = false;
            }
            let _ = pet.set_ignore_cursor_events(false);
        }
    });
}

/// 从素材文件名提取状态名（与前端 `pet-assets.ts#parseAssetName` 同一套约定，见 docs/pet-assets.md §2）。
/// `{state}.{ext}` / `{state}_N.{ext}`；jpeg 归一 jpg；不支持的扩展名返回 None。
/// 后缀剥离只认"纯数字后缀"：`my_state.png` 的状态是 `my_state`，`my_state_2.png` 也是 `my_state`。
fn pet_state_of_file_name(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    let (stem, ext) = lower.rsplit_once('.')?;
    let ext = if ext == "jpeg" { "jpg" } else { ext };
    if !matches!(ext, "png" | "jpg" | "gif" | "webp" | "svg") {
        return None;
    }
    let state = match stem.rsplit_once('_') {
        Some((base, suffix)) if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) => base,
        _ => stem,
    };
    if state.is_empty() { None } else { Some(state.to_string()) }
}

/// 扫描用户素材目录 `{appData}/pet-assets/`，返回 { 状态: [文件完整路径] }。
/// 约定见 docs/pet-assets.md。前端每次切换状态都调用本命令（目录极小，readdir 毫秒级），
/// 以换取"放图即生效、删图即回落"——比文件监视（watcher + 事件桥）简单一个量级。
///
/// 权限设计：前端不申请通用文件系统权限（tauri-plugin-fs），只暴露这个窄命令——
/// 应用自定义命令默认允许调用（见 Tauri v2 能力模型），插件命令才需要逐条 ACL。
#[tauri::command]
fn list_user_pet_assets(app: tauri::AppHandle) -> BTreeMap<String, Vec<String>> {
    let mut result: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let dir = match app.path().app_data_dir() {
        Ok(p) => p.join("pet-assets"),
        Err(_) => return result,
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return result, // 目录不存在 = 用户未放素材，回退链走内置
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if let Some(state) = pet_state_of_file_name(name) {
            result.entry(state).or_default().push(path.to_string_lossy().into_owned());
        }
    }
    result
}

/// 删除一张用户素材（v0.24.0）：路径必须落在 pet-assets 目录内（防任意删除）。
#[tauri::command]
fn delete_user_pet_asset(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager as _;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("找不到应用数据目录: {e}"))?
        .join("pet-assets");
    let requested = std::fs::canonicalize(&path).map_err(|_| "素材文件不存在".to_string())?;
    let root = std::fs::canonicalize(&dir).map_err(|e| format!("素材目录不可用: {e}"))?;
    ensure_within_dir(&requested, &root, "只能删除素材目录里的文件")?;
    if !requested.is_file() {
        return Err("目标不是文件".into());
    }
    std::fs::remove_file(&requested).map_err(|e| format!("删除失败: {e}"))
}

// ── 素材一键导出（v0.29.1） ────────────────────────────────────────────────
//
// 用户诉求：把“当前正在用的素材”打成一个 zip，带到另一台电脑或留档。
// 设计要点：
// - **导出的是生效文件**：只收状态白名单内的文件（与运行时 listVariants 的语义一致），
//   文件名原样保留（`happy.png` / `happy_001.png`）——解压后直接就是可用素材；
// - **内置兜底**：用户从没导入过时，当前生效的是内置 SVG；用 include_bytes! 编进
//   二进制，打包后也能按规范名导出（前端产物里是 hash 文件名，Rust 取不到原名）；
// - **跨平台编码**：条目名全部来自状态白名单 / 规范扩展名，是纯 ASCII。zip crate
//   以字节写入条目名；ASCII 在 Windows（资源管理器）与 macOS（归档实用工具）都按
//   同一编码解释，不触发 GBK/UTF-8 的代码页差异。中文文件名不会被导出（它们本来
//   也不被状态机识别）。

/// 素材导出目录（appData 之下）：与 backups/ 分开，避免“备份列表”混入素材包
const PET_ASSET_EXPORT_DIR: &str = "exports";

/// 导出结果（前端用于提示与 reveal）
#[derive(serde::Serialize)]
struct PetAssetExport {
    path: String,
    count: usize,
    /// "user" = 用户素材；"bundled" = 内置默认素材（用户还没导入过）
    source: &'static str,
}

/// 内置素材（10 个状态各一张 SVG）：用户目录为空时，“当前使用”的就是它们。
const BUNDLED_PET_ASSETS: [(&str, &[u8]); 10] = [
    ("idle.svg", include_bytes!("../../src/assets/pet/idle.svg")),
    ("happy.svg", include_bytes!("../../src/assets/pet/happy.svg")),
    ("sad.svg", include_bytes!("../../src/assets/pet/sad.svg")),
    ("thinking.svg", include_bytes!("../../src/assets/pet/thinking.svg")),
    ("talking.svg", include_bytes!("../../src/assets/pet/talking.svg")),
    ("alert.svg", include_bytes!("../../src/assets/pet/alert.svg")),
    ("stretch.svg", include_bytes!("../../src/assets/pet/stretch.svg")),
    ("focus.svg", include_bytes!("../../src/assets/pet/focus.svg")),
    ("break.svg", include_bytes!("../../src/assets/pet/break.svg")),
    ("sleep.svg", include_bytes!("../../src/assets/pet/sleep.svg")),
];

/// 纯函数（可单测）：文件名是否属于“当前生效的素材集合”。
/// 规则与 `list_user_pet_assets` + `PET_ASSET_STATES` 对齐：隐藏文件、未知状态、
/// 不支持的扩展名都不导出（它们本来就不会被启用）。
fn is_exportable_asset_name(name: &str) -> bool {
    if name.starts_with('.') {
        return false;
    }
    let Some(state) = pet_state_of_file_name(name) else { return false };
    PET_ASSET_STATES.contains(&state.as_str())
}

/// 一键导出当前素材（v0.29.1）：写 `{appData}/exports/mochi-pet-assets-<时间戳>.zip`，
/// 返回路径给 UI reveal。async：文件可能几十 MB，放线程池避免阻塞 IPC。
#[tauri::command]
async fn export_pet_assets(app: tauri::AppHandle) -> Result<PetAssetExport, String> {
    export_pet_assets_impl(&app)
}

fn export_pet_assets_impl(app: &tauri::AppHandle) -> Result<PetAssetExport, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("找不到应用数据目录: {e}"))?;
    let exports_dir = data_dir.join(PET_ASSET_EXPORT_DIR);
    std::fs::create_dir_all(&exports_dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let out_path = exports_dir.join(format!("mochi-pet-assets-{stamp}.zip"));

    let file = std::fs::File::create(&out_path).map_err(|e| format!("创建导出文件失败: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // ① 先收集用户目录：目录里只要有一张可识别素材，就不再导出内置（与运行时
    //    “用户配过图就不再混默认形象”的语义一致）
    let mut user_files: Vec<(String, std::path::PathBuf)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(data_dir.join("pet-assets")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            if is_exportable_asset_name(name) {
                user_files.push((name.to_string(), path));
            }
        }
    }
    // 固定字典序：同一批素材导出的 zip 内容顺序稳定，便于比对/去重
    user_files.sort_by(|a, b| a.0.cmp(&b.0));

    let (count, source) = if user_files.is_empty() {
        for (name, bytes) in BUNDLED_PET_ASSETS {
            zip.start_file(name, options)
                .map_err(|e| format!("写入内置素材 {name} 失败: {e}"))?;
            std::io::Write::write_all(&mut zip, bytes)
                .map_err(|e| format!("写入内置素材 {name} 失败: {e}"))?;
        }
        (BUNDLED_PET_ASSETS.len(), "bundled")
    } else {
        for (name, path) in &user_files {
            let mut source_file = std::fs::File::open(path).map_err(|e| format!("读取素材 {name} 失败: {e}"))?;
            zip.start_file(name.as_str(), options)
                .map_err(|e| format!("写入素材条目 {name} 失败: {e}"))?;
            std::io::copy(&mut source_file, &mut zip)
                .map_err(|e| format!("写入素材 {name} 失败: {e}"))?;
        }
        (user_files.len(), "user")
    };

    zip.finish().map_err(|e| format!("收尾素材包失败: {e}"))?;
    Ok(PetAssetExport {
        path: out_path.to_string_lossy().into_owned(),
        count,
        source,
    })
}

/// 路径守卫（纯逻辑，可测）：requested 必须落在 root 之内。
fn ensure_within_dir(requested: &std::path::Path, root: &std::path::Path, message: &str) -> Result<(), String> {
    if requested.starts_with(root) {
        Ok(())
    } else {
        Err(message.to_string())
    }
}

// ── 宠物素材导入（v0.9.2） ─────────────────────────────────────────────────
//
// 为什么写文件放在 Rust：前端只拿到 core/store/sql/notification 这些插件权限，
// 没有通用文件系统权限（见 capabilities/default.json）。素材目录是应用数据目录里
// 唯一允许用户自定义的目录，**校验**（状态白名单 / 扩展名 / 大小）必须和写入在同一侧，
// 否则"前端过滤一次、Rust 再信一次"等于没过滤。
//
// 为什么用 base64 而不是新增 tauri-plugin-fs：为一次低频导入引入一个插件 + 一组
// ACL 权限不值得；图片通常 < 2MB，base64 的 33% 膨胀在桌面端可接受。解码自己写
// （约 20 行、有单测），避免为这点功能再加一个 crate 依赖。

/// 素材状态白名单——与前端 `PET_STATES`、docs/pet-assets.md §3 同一个集合。
const PET_ASSET_STATES: [&str; 10] = [
    "idle", "happy", "sad", "thinking", "talking", "alert", "stretch", "focus", "break", "sleep",
];
/// 支持的图片扩展名——与前端 `SUPPORTED_EXTS` 一致（jpeg 在入口处归一为 jpg）。
const PET_ASSET_EXTS: [&str; 5] = ["png", "jpg", "gif", "webp", "svg"];
/// 单文件上限：桌宠素材通常在 1MB 内；16MiB 用来兜住"误选视频/PSD"这类输入。
const PET_ASSET_MAX_BYTES: usize = 16 * 1024 * 1024;

/// 导入一张素材：写进 `{appData}/pet-assets/{state}[_N].{ext}`，返回最终文件名。
///
/// 文件名由 Rust 决定而不是前端传：变体序号要和目录现状一致（防覆盖、防并发下重名），
/// 只有写文件的一侧知道真实目录内容。前端只负责预览（同算法，纯函数可单测）。
///
/// `frame`（v0.10.0）：来自 `{state}_001.png` 这类**帧序列**文件名。给了序号就原样
/// 保留成 `{state}_{:03}.{ext}`——帧的位置由序号决定，改名等于改播放顺序；
/// 同序号重复导入视为"更新这一帧"，允许覆盖（与变体的"绝不覆盖"是有意的区别）。
#[tauri::command]
fn save_pet_asset(
    app: tauri::AppHandle,
    state: String,
    ext: String,
    base64: String,
    frame: Option<u32>,
) -> Result<String, String> {
    let state = state.trim().to_ascii_lowercase();
    if !PET_ASSET_STATES.contains(&state.as_str()) {
        return Err(format!("未知状态：{state}"));
    }
    let ext = ext.trim().to_ascii_lowercase();
    let ext = if ext == "jpeg" { "jpg".to_string() } else { ext };
    if !PET_ASSET_EXTS.contains(&ext.as_str()) {
        return Err(format!("不支持的图片格式：{ext}"));
    }
    let bytes = decode_base64(&base64).map_err(|e| format!("图片数据解析失败：{e}"))?;
    if bytes.is_empty() {
        return Err("图片是空的".to_string());
    }
    if bytes.len() > PET_ASSET_MAX_BYTES {
        return Err("图片超过 16MB，请先压缩再导入".to_string());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("找不到应用数据目录：{e}"))?
        .join("pet-assets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建素材目录失败：{e}"))?;
    let name = match frame {
        Some(index) if index > 0 => format!("{state}_{index:03}.{ext}"),
        _ => next_asset_file_name(&dir, &state, &ext),
    };
    std::fs::write(dir.join(&name), &bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok(name)
}

/// 取下一个可用文件名：`state.ext` → `state_2.ext` → `state_3.ext`…
/// （与 docs/pet-assets.md §2 的变体约定一致：序号从 2 开始，绝不覆盖已有素材。）
fn next_asset_file_name(dir: &std::path::Path, state: &str, ext: &str) -> String {
    let base = format!("{state}.{ext}");
    if !dir.join(&base).exists() {
        return base;
    }
    for index in 2..=9999u32 {
        let candidate = format!("{state}_{index}.{ext}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    // 极端情况（同一状态上千张）：用时间戳兜底，宁可名字难看也不覆盖用户素材。
    format!("{state}_{}.{ext}", chrono_like_now().replace([':', '-', ' ', '.'], ""))
}

/// 标准 base64 解码（字母表 + `=` 填充，忽略换行/空格）。
///
/// 前端用 `FileReader.readAsDataURL` 拿到 `data:image/png;base64,...`，前缀由前端剥掉。
/// 自己写而不是加依赖：只需要这一种用法，出错返回 Err（不 panic），并有单测覆盖填充位。
fn decode_base64(input: &str) -> Result<Vec<u8>, &'static str> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let cleaned: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    // data URL 前缀忘了剥时给一句能看懂的错，而不是"非法字符"。
    if cleaned.starts_with(b"data:") {
        return Err("请先去掉 data: 前缀");
    }
    if cleaned.len() % 4 != 0 {
        return Err("长度不是 4 的倍数");
    }
    let mut out = Vec::with_capacity(cleaned.len() / 4 * 3);
    for chunk in cleaned.chunks(4) {
        let pad = chunk.iter().filter(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && chunk[..4 - pad].contains(&b'=')) {
            return Err("填充符位置不对");
        }
        let mut values = [0u8; 4];
        for (slot, &byte) in values.iter_mut().zip(chunk.iter()) {
            if byte != b'=' {
                *slot = sextet(byte).ok_or("含非法 base64 字符")?;
            }
        }
        out.push((values[0] << 2) | (values[1] >> 4));
        if pad < 2 {
            out.push((values[1] << 4) | (values[2] >> 2));
        }
        if pad < 1 {
            out.push((values[2] << 6) | values[3]);
        }
    }
    Ok(out)
}

/// 读取系统自启项真值（v0.9.1）—— 设置页挂载时调用，把「设置里的开关」与
/// 「系统里真实登记的启动项」对齐。
///
/// 为什么需要它：设置文件是应用私有数据，系统启动项是另一份事实。两者会因为
/// 用户手工清理任务管理器启动项、安全软件拦截、换安装路径而错位。只显示设置值
/// 就会出现"开关开着但开机不启动"。读失败返回 false（不抛错）：设置页据此提示，
/// 不影响其他设置项。
#[tauri::command]
fn get_autostart_enabled(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt as _;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// 距上次用户输入的秒数（learning/08 §3.1）。
/// 隐私红线：这是聚合数字，不含任何输入内容；失败返回 0（按"用户在场"处理，宁误安全向）。
/// Windows 走 user-idle 的 GetLastInputInfo；macOS 直连 CoreGraphics 聚合查询。
#[tauri::command]
fn get_idle_seconds() -> u64 {
    platform_idle_seconds()
}

#[cfg(target_os = "windows")]
fn platform_idle_seconds() -> u64 {
    user_idle::UserIdle::get_time()
        .map(|idle| idle.as_seconds())
        .unwrap_or(0)
}

// Rust 2024 要求 FFI 声明块显式 unsafe；此符号由 macOS 自带的 CoreGraphics 提供。
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
}

#[cfg(target_os = "macos")]
fn platform_idle_seconds() -> u64 {
    // SAFETY: Apple API 的两个参数均为按值传入的枚举/整数，无指针或资源生命周期。
    // 0 = kCGEventSourceStateCombinedSessionState；u32::MAX = kCGAnyInputEventType。
    // 仅查询距上次任意输入的聚合秒数，不建立 event tap、不监听或读取输入内容。
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
    normalize_idle_seconds(seconds)
}

#[cfg(any(target_os = "macos", test))]
fn normalize_idle_seconds(seconds: f64) -> u64 {
    if seconds.is_finite() && seconds >= 0.0 { seconds as u64 } else { 0 }
}

// 本项目只支持 Windows/macOS；其他目标保守按“在场”处理，不错误推迟提醒。
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn platform_idle_seconds() -> u64 { 0 }

// ── 游戏模式：前台全屏检测（v0.9.0 自迭代，仅 Windows） ──────────────────
// 隐私边界：只读前台窗口与显示器的**矩形几何**，不读应用名/标题/进程/内容——
// 与 learning/08 §3 红线一致（"能推断用户在忙什么"的前台嗅探不做）。

/// 前台窗口是否全屏覆盖其显示器（矩形几何，windows 实现）。
#[cfg(windows)]
fn foreground_fullscreen_monitor() -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect};

    // SAFETY: 四个 Win32 调用均为查询型（无分配/无回调），句柄与指针参数按
    // 文档约定传入；GetMonitorInfoW 的 cbSize 先行设置。
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }
        let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if hmon.is_invalid() {
            return None;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(hmon, &mut info).as_bool() {
            Some((
                info.rcMonitor.left,
                info.rcMonitor.top,
                info.rcMonitor.right - info.rcMonitor.left,
                info.rcMonitor.bottom - info.rcMonitor.top,
            ))
        } else {
            None
        }
    }
}

// 非 Windows 目标：游戏模式可用但检测恒返回 None（设置页在 macOS 上禁用开关）。
#[cfg(not(windows))]
fn foreground_fullscreen_monitor() -> Option<(i32, i32, i32, i32)> {
    None
}

/// 宠物窗当前是否位于指定显示器上（矩形相等近似：同一显示器的 position/size
/// 稳定一致）。只在"全屏屏 == 宠物屏"时隐藏——别的屏全屏不该波及宠物。
#[cfg(windows)]
fn pet_on_monitor(app: &tauri::AppHandle, monitor: &(i32, i32, i32, i32)) -> bool {
    let Some(pet) = app.get_webview_window("pet") else { return false };
    let Ok(current) = pet.current_monitor() else { return false };
    let Some(m) = current else { return false };
    let pos = m.position();
    let size = m.size();
    (pos.x, pos.y, size.width as i32, size.height as i32) == *monitor
}

/// 显示并聚焦聊天窗。show() 不夺焦，聊天窗要接住用户输入必须显式 set_focus。
fn show_chat(app: &tauri::AppHandle) {
    if let Some(chat) = app.get_webview_window("chat") {
        let _ = chat.show();
        let _ = chat.set_focus();
    }
}

/// 显示/隐藏宠物窗（托盘左键与事件共用入口）。
/// is_visible 返回 Err（窗口不存在等异常态）时按「尝试显示」处理，倾向自愈。
fn toggle_pet(app: &tauri::AppHandle) {
    if let Some(pet) = app.get_webview_window("pet") {
        match pet.is_visible() {
            Ok(true) => {
                let _ = pet.hide();
            }
            _ => {
                let _ = pet.show();
            }
        }
    }
}

/// 启动时的宠物窗定位（v0.9.0 P0-04）：
/// ① 显式恢复 window-state 持久化的上次位置（拖到哪下次启动就在哪，含副屏）；
/// ② 校验恢复出的坐标确实落在某台显示器的可见范围内——拔掉副屏/改分辨率后
///    旧坐标可能整个悬在屏幕外，此时回退右下角默认位（自愈，不白屏不丢失）。
/// ③ 没有任何持久化记录（首次安装）时，restore_state 是无操作 → 走右下角默认位。
fn ensure_pet_position(app: &tauri::App) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let _ = pet.restore_state(StateFlags::POSITION);
    if pet_position_visible(&pet) {
        return;
    }
    position_pet_bottom_right(app.handle());
}

/// 窗口当前外接矩形是否与任一显示器的可视范围相交。
/// 允许部分超出（拖到屏幕边缘留一半是用户自由），只拦截"完全不可见"。
fn pet_position_visible(pet: &tauri::WebviewWindow) -> bool {
    let (Ok(pos), Ok(size), Ok(monitors)) =
        (pet.outer_position(), pet.outer_size(), pet.available_monitors())
    else {
        return false; // 几何信息拿不到 = 状态不可信，交由调用方回退默认位
    };
    let (px, py, pw, ph) = (pos.x, pos.y, size.width as i32, size.height as i32);
    monitors.iter().any(|m| {
        let (mx, my, mw, mh) = (
            m.position().x,
            m.position().y,
            m.size().width as i32,
            m.size().height as i32,
        );
        px < mx + mw && px + pw > mx && py < my + mh && py + ph > my
    })
}

/// 应用宠物大小档位（v0.25.0：0.2~2 连续档，滑杆驱动）：改窗口逻辑尺寸 → 保持**中心**
/// 锚点重定位 → 屏内 clamp（v0.29.1：原右下角锚点会让放大时形象向左上“顶点”偏移，
/// 现在窗口中心不动，视觉上就是围绕宠物中心缩放）。
fn apply_pet_scale(app: &tauri::AppHandle, scale: f64) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(old_pos) = pet.outer_position() else {
        return;
    };
    let Ok(old_size) = pet.outer_size() else {
        return;
    };
    // 缩放会 set_size + set_position：先抑制拖拽判定，否则 Moved 会被当成"用户抓住"
    suppress_programmatic_moves(app);
    // 按逻辑像素缩放：高 DPI 物理换算交给 Tauri（设计基准 220×260，见常量注释）
    if pet.set_size(tauri::LogicalSize::new(PET_BASE_WIDTH * scale, PET_BASE_HEIGHT * scale)).is_err() {
        return;
    }
    let Ok(new_size) = pet.outer_size() else {
        return;
    };
    // 中心锚点：窗口中心在屏幕上保持不动，缩放不再向某个角偏移
    let x = old_pos.x + (old_size.width as i32 - new_size.width as i32) / 2;
    let y = old_pos.y + (old_size.height as i32 - new_size.height as i32) / 2;
    let _ = pet.set_position(tauri::PhysicalPosition::new(x, y));
    if !pet_position_visible(&pet) {
        position_pet_bottom_right(app);
    }
}

/// 菜单展开后宠物窗的位移（逻辑 px，v0.29.1）：`new_pos - old_pos`。
/// 前端用它把右键坐标从“展开前的视口”换算到“展开后的视口”。
#[derive(serde::Serialize)]
struct PetMenuShift {
    dx: f64,
    dy: f64,
}

/// 打开右键菜单前的窗口准备（v0.29.1）。
///
/// 为什么需要：宠物大小 0.2× 时窗口只有 44×52 逻辑 px，而菜单自身固定 150px 宽——
/// 仅靠 CSS 会被 `max-width: calc(100vw - 8px)` 压成几十像素，字号也被溢出滚动挤压。
/// 这里在菜单打开期间把窗口临时扩到至少 `PET_MENU_MIN_*`，菜单就能按默认 1.0 尺寸
/// 渲染；关闭时由 `restore_pet_menu` 原样还原。
///
/// 几何关键：**只向上、向左右对称扩**——宠物形象是“水平居中 + 贴底”布局，
/// 这样扩完窗口后形象在屏幕上的位置完全不动（不会看到宠物跳一下）。
#[tauri::command]
fn prepare_pet_menu(app: tauri::AppHandle) -> Result<PetMenuShift, String> {
    // 接下来的移动都是程序性的（含可能的躲藏恢复）：不要喂给拖拽状态机
    suppress_programmatic_moves(&app);
    // 躲藏（贴边只留一条）时先恢复停靠位：菜单需要完整可见的窗口
    restore_from_peek(&app);
    let pet = app.get_webview_window("pet").ok_or_else(|| "宠物窗不存在".to_string())?;
    {
        let state = app.state::<Mutex<PetMenuSpace>>();
        let guard = state.lock().map_err(|_| "菜单状态锁失效".to_string())?;
        if guard.backup.is_some() {
            // 已为菜单扩过窗口：当前坐标仍是有效视口坐标
            return Ok(PetMenuShift { dx: 0.0, dy: 0.0 });
        }
    }
    let old_pos = pet.outer_position().map_err(|e| e.to_string())?;
    let old_size = pet.outer_size().map_err(|e| e.to_string())?;
    let sf = pet.scale_factor().map_err(|e| e.to_string())?;
    let old_logical = old_size.to_logical::<f64>(sf);
    let target = tauri::LogicalSize::new(
        old_logical.width.max(PET_MENU_MIN_WIDTH),
        old_logical.height.max(PET_MENU_MIN_HEIGHT),
    );
    // 已经够大（常见于 1.0× 及以上）：不扩、不记录，restore 自然无事可做
    if (target.width - old_logical.width).abs() < 0.5 && (target.height - old_logical.height).abs() < 0.5 {
        return Ok(PetMenuShift { dx: 0.0, dy: 0.0 });
    }
    pet.set_size(target).map_err(|e| format!("扩大菜单窗口失败: {e}"))?;
    let new_size = pet.outer_size().map_err(|e| e.to_string())?;
    let dx_px = (old_size.width as i32 - new_size.width as i32) / 2;
    let dy_px = old_size.height as i32 - new_size.height as i32;
    let new_pos = tauri::PhysicalPosition::new(old_pos.x + dx_px, old_pos.y + dy_px);
    pet.set_position(new_pos).map_err(|e| format!("移动菜单窗口失败: {e}"))?;
    // 记录原始几何；锁失败则立即回滚，避免窗口停在一个无法恢复的尺寸
    let stored = match app.state::<Mutex<PetMenuSpace>>().lock() {
        Ok(mut guard) => {
            guard.backup = Some((old_logical, old_pos));
            true
        }
        Err(_) => false,
    };
    if !stored {
        let _ = pet.set_size(old_logical);
        let _ = pet.set_position(old_pos);
        return Err("菜单状态锁失效".to_string());
    }
    Ok(PetMenuShift { dx: dx_px as f64 / sf, dy: dy_px as f64 / sf })
}

/// 关闭右键菜单后恢复窗口几何（v0.29.1）：幂等，没扩过窗口时是空操作。
#[tauri::command]
fn restore_pet_menu(app: tauri::AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else { return };
    // 还原几何同样是程序性移动，避免 400ms 后被误判成"松手"触发贴边
    suppress_programmatic_moves(&app);
    let backup = app
        .state::<Mutex<PetMenuSpace>>()
        .lock()
        .ok()
        .and_then(|mut guard| guard.backup.take());
    if let Some((size, position)) = backup {
        let _ = pet.set_size(size);
        let _ = pet.set_position(position);
    }
}

/// 把宠物窗放到主屏右下角（贴边留 24 逻辑像素边距）。
///
/// 坐标体系注意：monitor.size() / outer_size() 都是**物理像素**，
/// 而 margin 我们按逻辑像素设计，所以要乘 scale_factor 再取整。
/// v0.9.0 合并说明：改用 Tauri 2.12 `Monitor::work_area()`（扣除任务栏/Dock/
/// 菜单栏后的可见区域）——取代旧版 Windows 专属的 SPI_GETWORKAREA 手写查询
/// （省掉 windows crate 依赖），且 macOS 上它基于 NSScreen.visibleFrame 实现，
/// 旧版"宠物压住 Dock"的已知限制随之解决。
fn position_pet_bottom_right(app: &tauri::AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(Some(monitor)) = pet.primary_monitor() else {
        return;
    };
    let Ok(win_size) = pet.outer_size() else {
        return;
    };

    let scale = monitor.scale_factor();
    let margin = (24.0 * scale).round() as i32;
    let area = monitor.work_area();
    let x = area.position.x + (area.size.width as i32 - win_size.width as i32 - margin).max(0);
    let y = area.position.y + (area.size.height as i32 - win_size.height as i32 - margin).max(0);

    let _ = pet.set_position(tauri::PhysicalPosition::new(x, y));
}

#[cfg(test)]
mod alert_tests {
    use super::*;

    fn item(id: &str) -> AppAlert {
        AppAlert { id: id.into(), kind: AlertKind::Reminder, title: "到点提醒".into(), body: "喝水".into() }
    }

    #[test]
    fn idle_query_rejects_invalid_values_and_uses_whole_seconds() {
        assert_eq!(normalize_idle_seconds(f64::NAN), 0);
        assert_eq!(normalize_idle_seconds(f64::INFINITY), 0);
        assert_eq!(normalize_idle_seconds(-1.0), 0);
        assert_eq!(normalize_idle_seconds(300.9), 300);
    }

    #[test]
    fn queue_deduplicates_delivery_retries() {
        let mut queue = AlertQueue::default();
        assert!(queue.enqueue(item("one")));
        assert!(!queue.enqueue(item("one")));
        assert_eq!(queue.items.len(), 1);
    }

    #[test]
    fn stale_ack_cannot_remove_current_or_next() {
        let mut queue = AlertQueue::default();
        queue.enqueue(item("one"));
        queue.enqueue(item("two"));
        assert!(queue.acknowledge("wrong").is_none());
        assert_eq!(queue.items.len(), 2);
        assert_eq!(queue.acknowledge("one").unwrap().id, "one");
        assert!(queue.acknowledge("one").is_none());
        assert_eq!(queue.items.front().unwrap().id, "two");
    }

    #[test]
    fn dismiss_pending_does_not_touch_current() {
        let mut queue = AlertQueue::default();
        queue.enqueue(item("one"));
        queue.enqueue(item("two"));
        assert!(!queue.dismiss("two"));
        assert_eq!(queue.items.front().unwrap().id, "one");
        assert!(queue.dismiss("one"));
        assert!(queue.items.is_empty());
    }

    #[test]
    fn alert_is_clamped_inside_negative_monitor_work_area() {
        assert_eq!(alert_position((-1920, -100), (220, 260), (320, 200), (-1920, 0, 1920, 1040)), (-1920, 172));
        assert_eq!(alert_position((-50, 1030), (220, 260), (320, 200), (-1920, 0, 1920, 1040)), (-320, 818));
    }

    #[test]
    fn top_edge_uses_below_and_tiny_work_area_never_panics() {
        assert_eq!(alert_position((100, 0), (220, 260), (320, 200), (0, 0, 1920, 1040)), (50, 272));
        assert_eq!(alert_position((100, 0), (220, 260), (320, 200), (0, 0, 200, 100)), (0, 0));
    }

    #[test]
    fn drag_starts_on_first_move_and_broadcasts_once() {
        assert_eq!(drag_transition(false, None), None); // 未动不发事件
        assert_eq!(drag_transition(false, Some(0)), Some(true)); // 首次 Moved → 开始
        assert_eq!(drag_transition(true, Some(0)), None); // 拖拽中：不重复广播
    }

    #[test]
    fn drag_ends_only_after_quiet_window() {
        assert_eq!(drag_transition(true, Some(399)), None); // 静默未满窗：继续拖
        assert_eq!(drag_transition(true, Some(400)), Some(false)); // 恰到窗口 → 放手
        assert_eq!(drag_transition(true, Some(10_000)), Some(false)); // 睡眠唤醒补判
        assert_eq!(drag_transition(false, Some(999)), Some(true)); // 放手后又移动 → 新一轮
    }

    #[test]
    fn cursor_hit_test_matches_sprite_with_margin_and_dpi() {
        // 窗口在 (1000, 800) 物理 px，DPI 1.5，形象逻辑矩形 (10, 20, 200, 240)
        let sprite = (10.0, 20.0, 200.0, 240.0);
        let win = (1000.0, 800.0);
        let scale = 1.5;
        // 换算：物理矩形 = (1015, 830) 到 (1315, 1190)；8 逻辑 px 余量 → (1003, 818)~(1327, 1202)
        let inside = (1165.0, 1010.0);
        assert!(cursor_hits_sprite(inside, win, scale, sprite, 8.0));
        // 窗口内但形象上沿之上（物理 y=810 < 余量下沿 818）→ 不命中（透明区穿透）
        assert!(!cursor_hits_sprite((1165.0, 810.0), win, scale, sprite, 8.0));
        // 上沿上方 1 物理 px（在余量带内）→ 命中（手感余量）
        assert!(cursor_hits_sprite((1165.0, 829.0), win, scale, sprite, 8.0));
        // 窗口外远处
        assert!(!cursor_hits_sprite((0.0, 0.0), win, scale, sprite, 8.0));
        // 防御：非法 scale / 零尺寸一律不命中
        assert!(!cursor_hits_sprite(inside, win, 0.0, sprite, 8.0));
        assert!(!cursor_hits_sprite(inside, win, scale, (10.0, 20.0, 0.0, 240.0), 8.0));
    }

    #[test]
    fn fullscreen_cover_tolerates_edge_noise_but_not_windows() {
        // 1920×1080 显示器：精确全屏 / 带任务栏遮蔽 2px 都算全屏
        assert!(is_fullscreen_cover((0, 0, 1920, 1080), (0, 0, 1920, 1080)));
        assert!(is_fullscreen_cover((-2, -1, 1922, 1080), (0, 0, 1920, 1080)));
        // 普通窗口化（宽或高不足 97%）不算
        assert!(!is_fullscreen_cover((0, 0, 1600, 900), (0, 0, 1920, 1080)));
        assert!(!is_fullscreen_cover((0, 0, 1920, 900), (0, 0, 1920, 1080)));
        // 防御：零尺寸显示器恒 false（除零保护）
        assert!(!is_fullscreen_cover((0, 0, 1920, 1080), (0, 0, 0, 0)));
    }

    /// base64 解码是素材导入的唯一数据入口：三种填充位 + 脏输入都要有断言。
    /// 期望值用标准实现对照（"Man" / "Ma" / "M" 分别覆盖 0/1/2 个填充符）。
    #[test]
    fn base64_decodes_all_padding_cases() {
        assert_eq!(decode_base64("TWFu").unwrap(), b"Man");
        assert_eq!(decode_base64("TWE=").unwrap(), b"Ma");
        assert_eq!(decode_base64("TQ==").unwrap(), b"M");
        // 换行/空格（部分阅读器导出的 base64 会折行）不影响结果
        assert_eq!(decode_base64("TWFu\nTWFu").unwrap(), b"ManMan");
        // 空串是合法的（上层再判断"图片是空的"）
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn base64_rejects_malformed_input() {
        assert!(decode_base64("TWF").is_err()); // 长度不是 4 的倍数
        assert!(decode_base64("TW*u").is_err()); // 非法字符
        assert!(decode_base64("T===").is_err()); // 填充符过多
        assert!(decode_base64("data:image/png;base64,TWFu").is_err()); // 忘了剥前缀
    }

    /// 变体序号必须"避开已有文件"：这就是导入不覆盖用户素材的保证。
    #[test]
    fn next_asset_file_name_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("mochi-asset-name-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        assert_eq!(next_asset_file_name(&dir, "happy", "png"), "happy.png");
        std::fs::write(dir.join("happy.png"), b"x").unwrap();
        assert_eq!(next_asset_file_name(&dir, "happy", "png"), "happy_2.png");
        std::fs::write(dir.join("happy_2.png"), b"x").unwrap();
        assert_eq!(next_asset_file_name(&dir, "happy", "png"), "happy_3.png");
        // 不同扩展名各算各的：happy.gif 不占用 happy.png 的序号
        assert_eq!(next_asset_file_name(&dir, "happy", "gif"), "happy.gif");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 贴边吸附（v0.10.0）：只在阈值内吸附，远处一律不动；负坐标副屏也成立。
    #[test]
    fn snap_pulls_only_near_edges() {
        let area = (0, 0, 1920, 1040); // 工作区已扣除任务栏
        let size = (220, 260);
        // 距左边 10px → 贴左；距右边 8px → 贴右
        assert_eq!(snap_to_work_area((10, 300), size, area, 24), (0, 300));
        assert_eq!(snap_to_work_area((1692, 300), size, area, 24), (1700, 300));
        // 距顶 5px → 贴顶；距底 12px → 贴底
        assert_eq!(snap_to_work_area((600, 5), size, area, 24), (600, 0));
        assert_eq!(snap_to_work_area((600, 768), size, area, 24), (600, 780));
        // 屏幕中间 → 不动（不做全局 clamp：允许用户故意放在偏外）
        assert_eq!(snap_to_work_area((600, 400), size, area, 24), (600, 400));
        // 刚好超出阈值 1px → 不吸
        assert_eq!(snap_to_work_area((25, 300), size, area, 24), (25, 300));
        // 负坐标副屏：以工作区原点为基准
        assert_eq!(
            snap_to_work_area((-1910, 300), size, (-1920, 0, 1920, 1040), 24),
            (-1920, 300)
        );
    }

    /// 松手速度估算（v0.12.0）：样本不足、时间窗过短都不能给速度——
    /// 否则手抖一下就会被判成"甩出去"，窗口自己弹走。
    #[test]
    fn drag_velocity_requires_real_samples() {
        use std::time::{Duration, Instant};
        let now = Instant::now();
        let mut empty: VecDeque<(i32, i32, Instant)> = VecDeque::new();
        assert!(drag_velocity(&empty).is_none());
        empty.push_back((0, 0, now));
        assert!(drag_velocity(&empty).is_none()); // 只有一个点

        let mut jitter: VecDeque<(i32, i32, Instant)> = VecDeque::new();
        jitter.push_back((0, 0, now));
        jitter.push_back((5, 0, now + Duration::from_millis(8)));
        assert!(drag_velocity(&jitter).is_none()); // 时间窗 < 16ms，算出来是噪声

        let mut fast: VecDeque<(i32, i32, Instant)> = VecDeque::new();
        fast.push_back((0, 0, now));
        fast.push_back((100, 0, now + Duration::from_millis(100)));
        let (vx, vy) = drag_velocity(&fast).expect("100px/100ms 应有速度");
        assert!((vx - 1000.0).abs() < 1.0);
        assert!(vy.abs() < 1e-9);
    }

    /// 惯性积分（v0.12.0）：摩擦衰减、撞边清零、慢速立即停、异常速度限幅。
    #[test]
    fn inertia_slides_and_stops_at_edges() {
        let area = (0, 0, 1920, 1040);
        let size = (220, 260);

        // 1000px/s × 16ms = 16px；速度按摩擦衰减
        let (pos, vel, done) = inertia_step((600, 400), (1000.0, 0.0), 16.0, size, area);
        assert_eq!(pos, (616, 400));
        assert!(!done);
        assert!((vel.0 - 880.0).abs() < 1e-6);

        // 撞右边界：max_x = 1920 - 220 = 1700，横向速度清零并结束
        let (pos, vel, done) = inertia_step((1700, 400), (2000.0, 0.0), 16.0, size, area);
        assert_eq!(pos, (1700, 400));
        assert_eq!(vel.0, 0.0);
        assert!(done);

        // 慢速（30px/s → 衰减后 26.4px/s，低于 40 阈值，且位移取整为 0）：一步即停
        let (pos, vel, done) = inertia_step((600, 400), (30.0, 0.0), 16.0, size, area);
        assert_eq!(pos, (600, 400));
        assert!((vel.0 - 26.4).abs() < 1e-9);
        assert!(done);

        // 异常速度（跨屏跳变等）：单帧位移被限幅到 120px，不瞬移
        let (pos, _, _) = inertia_step((100, 400), (100_000.0, 0.0), 16.0, size, area);
        assert_eq!(pos, (220, 400));

        // 非法 dt：不动、速度归零、直接结束（防御）
        let (pos, vel, done) = inertia_step((300, 300), (500.0, 500.0), 0.0, size, area);
        assert_eq!(pos, (300, 300));
        assert_eq!(vel, (0.0, 0.0));
        assert!(done);
    }

    /// 素材删除的路径守卫（v0.24.0）：目录内的文件放行，目录外一律拒绝。
    #[test]
    fn ensure_within_dir_blocks_outside_paths() {
        let root = std::path::Path::new("/data/app/pet-assets");
        assert!(ensure_within_dir(
            std::path::Path::new("/data/app/pet-assets/happy.png"),
            root,
            "deny"
        ).is_ok());
        assert!(ensure_within_dir(std::path::Path::new("/data/app/other.png"), root, "deny").is_err());
        assert!(ensure_within_dir(std::path::Path::new("/data/app/pet-assets-secret/x.png"), root, "deny").is_err());
    }

    /// 自动贴边几何（v0.29.0）：最近边判定 / 躲藏位 / 停靠位 / 唤回区。
    #[test]
    fn auto_dock_geometry_and_wake() {
        let area = (0, 0, 1920, 1040);
        // 窗口贴近右缘（右距 30px）→ 最近边是 Right
        let rect = (1670, 500, 220, 260);
        let (edge, dist) = nearest_edge(rect, area);
        assert_eq!(edge, Edge::Right);
        assert_eq!(dist, 30);
        // 贴左缘（x=30）
        let (edge, _) = nearest_edge((30, 300, 220, 260), area);
        assert_eq!(edge, Edge::Left);
        // 底缘（y+h 距 ah 30）
        let rect_b = (500, 1040 - 290, 220, 260);
        let (edge, _) = nearest_edge(rect_b, area);
        assert_eq!(edge, Edge::Bottom);

        // 躲藏位（右缘）：只留 16px
        let peek = peek_position(Edge::Right, rect, area, 16);
        assert_eq!(peek.0, 1920 - 16); // ax+aw-sliver
        assert!(peek.1 >= 0 && peek.1 <= 1040 - 260); // 沿边夹在工作区内
        // 停靠位（右缘）：完整显示贴边
        let dock = dock_position(Edge::Right, rect, area);
        assert_eq!(dock.0, 1920 - 220);

        // 唤回：光标进入右缘 wake 带（≤48px）且沿边在窗口跨度±120 内
        assert!(cursor_wakes_peek((1920 - 40, 560), Edge::Right, rect, area, 48));
        assert!(!cursor_wakes_peek((1920 - 200, 560), Edge::Right, rect, area, 48)); // 离边太远
        assert!(!cursor_wakes_peek((1920 - 40, 20), Edge::Right, rect, area, 48)); // 沿边太远（跨度外）
        // 左缘对称
        assert!(cursor_wakes_peek((30, 560), Edge::Left, (30, 300, 220, 260), area, 48));
    }

    /// 脱敏（v0.16.0）：Key 形态打码、短前缀不误伤、Bearer 打码、正常文本不变。
    #[test]
    fn redact_masks_key_shaped_tokens_but_not_short_prefixes() {
        assert_eq!(redact_message("sk-abcdefghijklmnop1234"), "sk-***");
        assert_eq!(redact_message("key=sk-abc123XYZ_-9x"), "key=sk-***");
        // 短于 6 位的段不是 Key 形态（如 task-1 / sk-1），原样保留
        assert_eq!(redact_message("task-skill-1"), "task-skill-1");
        assert_eq!(redact_message("Bearer eyJhbGciOiJIUzI1Ng"), "Bearer ***");
        assert_eq!(redact_message("连接失败: timeout"), "连接失败: timeout");
        // 空串安全
        assert_eq!(redact_message(""), "");
    }

    /// 脱敏截断（v0.16.0）：超长按字符截断并留提示——日志不该成为新的存储。
    #[test]
    fn redact_truncates_overlong_messages_by_chars() {
        let long = "啊".repeat(2000);
        let out = redact_message(&long);
        assert!(out.chars().count() <= LOG_MESSAGE_MAX_CHARS + 8);
        assert!(out.ends_with("…（截断）"));
        // 含密钥的超长消息：打码 + 截断同时成立
        let mixed = format!("{} {}", "前缀", "sk-abcdefghijklmnopqrstuvwxyz");
        assert!(redact_message(&mixed).contains("sk-***"));
    }

    /// 轮转（v0.16.0）：换名绝不覆盖已有序号；99 个占满后放弃但不丢当前文件。
    #[test]
    fn rotate_log_file_never_overwrites_previous() {
        let dir = std::env::temp_dir().join(format!("mochi-log-rotate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        let main = dir.join("mochi-2026-11-17.log");
        std::fs::write(&main, b"first").unwrap();
        rotate_log_file(&dir, &main);
        assert!(!main.exists());
        assert_eq!(std::fs::read(dir.join("mochi-2026-11-17.log.1")).unwrap(), b"first");
        // 第二次轮转：序号避让
        std::fs::write(&main, b"second").unwrap();
        rotate_log_file(&dir, &main);
        assert_eq!(std::fs::read(dir.join("mochi-2026-11-17.log.2")).unwrap(), b"second");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 清理（v0.16.0）：只删"自己的 + 过期的"日志——外借文件、last-panic、
    /// 未过期的日志都不能碰。
    #[test]
    fn cleanup_only_removes_own_expired_logs() {
        use std::time::{Duration, SystemTime};
        let dir = std::env::temp_dir().join(format!("mochi-log-clean-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建临时目录");

        let expired = dir.join("mochi-2026-01-01.log");
        let rotated = dir.join("mochi-2026-01-01.log.1");
        let fresh = dir.join("mochi-today.log");
        let foreign = dir.join("user-data.log");
        let panic_file = dir.join(LAST_PANIC_FILE);
        for path in [&expired, &rotated, &fresh, &foreign, &panic_file] {
            std::fs::write(path, b"x").unwrap();
        }
        // 把 expired / rotated 的修改时间拨回 8 天前（fresh 保持现在）
        let old = SystemTime::now() - Duration::from_secs(8 * 86400);
        let _ = filetime_set(&expired, old);
        let _ = filetime_set(&rotated, old);

        cleanup_old_logs(&dir);
        assert!(!expired.exists(), "过期日志应被删除");
        assert!(!rotated.exists(), "过期轮转文件同样删除");
        assert!(fresh.exists(), "未过期日志保留");
        assert!(foreign.exists(), "别人的文件绝不碰");
        assert!(panic_file.exists(), "崩溃摘要不受清理影响");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 测试辅助：设置文件修改时间（std `File::set_modified`，Rust 1.75+ 稳定，
    /// 跨平台——清理判据是 mtime，测试必须能构造"旧文件"）。
    fn filetime_set(path: &std::path::Path, time: std::time::SystemTime) -> Result<(), ()> {
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|_| ())?
            .set_modified(time)
            .map_err(|_| ())
    }

    /// 备份条目白名单（v0.17.0）：已知条目通过、zip slip 与越权路径全部拒绝。
    #[test]
    fn classify_entry_rejects_slip_and_unknown_paths() {
        // 允许：三个根文件 + pet-assets 单层文件名
        assert_eq!(classify_entry("manifest.json"), Ok(EntryKind::Manifest));
        assert_eq!(classify_entry("settings.json"), Ok(EntryKind::Settings));
        assert_eq!(classify_entry("mochi.db"), Ok(EntryKind::Database));
        assert_eq!(classify_entry("pet-assets/happy.png"), Ok(EntryKind::Asset("happy.png".into())));
        // 拒绝：目录穿越 / 绝对路径 / 反斜杠 / 子目录 / 隐藏文件 / 未知条目
        assert!(classify_entry("../escape.txt").is_err());
        assert!(classify_entry("pet-assets/../../etc/passwd").is_err());
        assert!(classify_entry("pet-assets/.hidden").is_err());
        assert!(classify_entry("pet-assets/sub/x.png").is_err());
        assert!(classify_entry("C:\\Users\\x\\mochi.db").is_err());
        assert!(classify_entry("/abs/path").is_err());
        assert!(classify_entry("random.txt").is_err());
    }

    /// 素材导出白名单（v0.29.1）：只导出状态机真正会用的文件；
    /// 隐藏文件、未知状态、非图片扩展名全部拒绝。
    #[test]
    fn exportable_asset_names_follow_state_whitelist() {
        assert!(is_exportable_asset_name("idle.png"));
        assert!(is_exportable_asset_name("happy_001.PNG"));
        assert!(is_exportable_asset_name("break_2.webp"));
        assert!(!is_exportable_asset_name("unknown.png"));
        assert!(!is_exportable_asset_name("idle.txt"));
        assert!(!is_exportable_asset_name(".idle.png"));
        assert!(!is_exportable_asset_name("idle"));
    }

    /// 脱 Key 导出（v0.17.0）：apiKeys 清空、其余字段保留、非法 JSON 返回空对象。
    #[test]
    fn strip_api_keys_clears_keys_and_preserves_rest() {
        let input = r#"{"apiKeys":{"deepseek":"sk-secret"},"providerId":"deepseek","soundVolume":30}"#;
        let out = strip_api_keys(input);
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value.get("apiKeys"), Some(&serde_json::json!({})));
        assert_eq!(value.get("providerId"), Some(&serde_json::json!("deepseek")));
        assert_eq!(value.get("soundVolume"), Some(&serde_json::json!(30)));
        // 非 JSON 内容（文件损坏）：不把原文写进会被拷走的备份
        assert_eq!(strip_api_keys("not json at all sk-secret"), "{}");
    }
}
