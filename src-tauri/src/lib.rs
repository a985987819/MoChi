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

use std::{collections::{BTreeMap, VecDeque}, sync::Mutex, time::Duration};

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
/// 开机自启（v0.9.0 P1-14）：前端开关 → Rust 应用（enable/disable 系统项）
const EVT_AUTOSTART_CHANGED: &str = "state://autostart-changed";
/// 宠物大小档位（v0.9.0 P1-15）：前端 → Rust（改窗口尺寸）+ 宠物窗（CSS 变量）
const EVT_PET_SCALE_CHANGED: &str = "state://pet-scale-changed";
/// 拖拽状态边界广播（v0.9.0 手感优化）：开始/结束各一次，前端切握持/放下动画
const EVT_PET_DRAG_CHANGED: &str = "state://pet-drag-changed";
/// 宠物窗设计基准尺寸（tauri.conf.json 声明值；缩放按逻辑像素乘档位）
const PET_BASE_WIDTH: f64 = 220.0;
const PET_BASE_HEIGHT: f64 = 260.0;

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

/// 拖拽运动追踪：Moved 事件只在**边界**广播（开始一次/结束一次），
/// 每次移动都发事件会把 1Hz 的 IPC 变成 60Hz，前端反而被自己拖慢。
/// 结束判定靠"静默窗口"：原生拖动中 Moved 连续到达，停止移动 400ms 后视为放手。
#[derive(Default)]
struct DragMotion {
    dragging: bool,
    last_move_at: Option<std::time::Instant>,
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

/// 应用入口：组装 Tauri Builder（插件 → 托盘 → 事件 → 窗口行为）后进入事件循环。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // single-instance 必须最先注册：第二次启动进程时，回调在「已有实例」里执行
    let builder = tauri::Builder::default()
        .manage(Mutex::new(AlertQueue::default()))
        .manage(Mutex::new(DragMotion::default()))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 用户再次双击图标：不启动新进程，而是把已有宠物的窗口唤回前台
            if let Some(pet) = app.get_webview_window("pet") {
                let _ = pet.show();
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
            show_app_alert, get_app_alert, ack_app_alert, dismiss_app_alert
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
            // v0.9.0 P0-04：先恢复持久化位置 + 可见性校验，失败回退右下角默认位
            ensure_pet_position(app);
            // v0.8.2：原生节拍——隐藏窗口时 WebView 的 setInterval 会被节流
            start_native_tick(app.handle().clone());
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
                WindowEvent::Moved(_) if window.label() == "pet" => {
                    let app = window.app_handle().clone();
                    let state = app.state::<Mutex<DragMotion>>();
                    let mut motion = match state.lock() {
                        Ok(m) => m,
                        Err(_) => return, // 锁中毒：拖拽反馈是锦上添花，静默跳过
                    };
                    motion.last_move_at = Some(std::time::Instant::now());
                    if let Some(next) = drag_transition(motion.dragging, Some(0)) {
                        motion.dragging = next;
                        let _ = app.emit_to("pet", EVT_PET_DRAG_CHANGED, serde_json::json!({ "dragging": next }));
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

    TrayIconBuilder::with_id("mochi-tray")
        .icon(app.default_window_icon().expect("缺少应用图标").clone())
        .tooltip("Mochi 麻薯")
        .menu(&menu)
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
    let mut last = cache.lock().expect("托盘 tooltip 缓存锁中毒");
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
    let handle = app.clone();
    app.listen_any(EVT_DRAG_PET, move |_| {
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
        if let Err(e) = result {
            eprintln!("[autostart] 应用失败: {e}");
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
fn start_native_tick(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new().name("mochi-clock".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let handle = app.clone();
        // 窗口副作用统一调回 UI 线程，避免后台持锁等待窗口线程时与同步命令形成死锁。
        let _ = app.run_on_main_thread(move || {
            let _ = handle.emit_to("pet", EVT_NATIVE_TICK, ());
            let state = handle.state::<Mutex<AlertQueue>>();
            if let Ok(mut queue) = state.lock() {
                if queue.needs_present { let _ = present_alert(&handle, &mut queue); }
            };
            // 拖拽收尾：上次 Moved 静默超窗 → 广播「放下」。锁失败静默（反馈非关键路径）
            let drag_state = handle.state::<Mutex<DragMotion>>();
            if let Ok(mut motion) = drag_state.lock() {
                let age = motion.last_move_at.map(|t| t.elapsed().as_millis() as u64);
                if let Some(next) = drag_transition(motion.dragging, age) {
                    motion.dragging = next;
                    if !next {
                        motion.last_move_at = None;
                        let _ = handle.emit_to("pet", EVT_PET_DRAG_CHANGED, serde_json::json!({ "dragging": false }));
                    }
                }
            }
        });
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

/// 应用宠物大小档位（P1-15）：改窗口逻辑尺寸 → 保持右下角锚点重定位 →
/// 屏内 clamp（贴边缩小时可能顶出屏幕上沿，与 P0-04 共用自愈路径）。
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
    // 按逻辑像素缩放：高 DPI 物理换算交给 Tauri（设计基准 220×260，见常量注释）
    if pet.set_size(tauri::LogicalSize::new(PET_BASE_WIDTH * scale, PET_BASE_HEIGHT * scale)).is_err() {
        return;
    }
    let Ok(new_size) = pet.outer_size() else {
        return;
    };
    // 右下角锚点：用户把宠物放在角落时，缩放不应让它"跳走"
    let x = old_pos.x + (old_size.width as i32 - new_size.width as i32);
    let y = old_pos.y + (old_size.height as i32 - new_size.height as i32);
    let _ = pet.set_position(tauri::PhysicalPosition::new(x, y));
    if !pet_position_visible(&pet) {
        position_pet_bottom_right(app);
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
}
