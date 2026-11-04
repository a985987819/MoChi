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
//! 2. **逻辑单一来源**：托盘、双击宠物、快捷键（未来）都汇聚到同一组函数；
//! 3. **学习友好**：前端工程师只需要理解「emit 事件 → Rust 处理」这一条通信协议。
//!
//! # 生命周期模型
//!
//! 应用进程常驻托盘。三个窗口的「关闭按钮/系统关闭」一律被拦截为**隐藏**
//! （见 `on_window_event`），真正退出只走托盘菜单「退出 Mochi」。
//! 宠物窗（pet）是事实上的主窗口：它常驻可见，承载计时器（v0.7.0）等长期服务。

use std::{collections::{BTreeMap, VecDeque}, sync::Mutex, time::Duration};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Listener, Manager, WindowEvent,
};

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

/// 应用入口：组装 Tauri Builder（插件 → 托盘 → 事件 → 窗口行为）后进入事件循环。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // single-instance 必须最先注册：第二次启动进程时，回调在「已有实例」里执行
    let builder = tauri::Builder::default()
        .manage(Mutex::new(AlertQueue::default()))
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
        .invoke_handler(tauri::generate_handler![
            list_user_pet_assets, get_idle_seconds,
            show_app_alert, get_app_alert, ack_app_alert, dismiss_app_alert
        ]);

    builder
        .setup(|app| {
            // Tauri 2 的 activation policy 属于 App，而不是 Builder；仅 macOS 提供。
            // 在 setup 拿到 App 后设置 Accessory，才能跨平台编译并隐藏 Dock 图标。
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            setup_tray(app)?;
            setup_ui_event_listeners(app.handle().clone());
            position_pet_bottom_right(app);
            start_native_tick(app.handle().clone());
            Ok(())
        })
        // 拦截所有窗口的关闭请求 → 隐藏。Tauri 中窗口关闭默认会销毁窗口对象，
        // 隐藏则保留对象，之后 show() 零成本恢复（状态都在）。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
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
        })
        .run(tauri::generate_context!())
        .expect("Mochi 启动失败");
}

/// 构建托盘：图标 + 右键菜单 + 左键单击切换宠物显示。
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    // 菜单项三要素：id（事件分发用）、文案、是否可用；第四参是快捷键（暂无）
    // 命名注意：局部变量不能与下方 toggle_pet() 函数同名，否则遮蔽导致 E0618
    let toggle_item = MenuItem::with_id(app, "toggle-pet", "显示 / 隐藏麻薯", true, None::<&str>)?;
    let open_chat = MenuItem::with_id(app, "open-chat", "打开聊天", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Mochi", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle_item, &open_chat, &quit])?;

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
            "open-chat" => show_chat(app),
            "quit" => app.exit(0), // 唯一的真正退出入口（绕过窗口 hide 拦截）
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// 注册前端 → Rust 的 UI 事件监听。
/// `listen_any` 监听全局广播事件（前端 `emit()` 发出的事件所有监听者可见）。
fn setup_ui_event_listeners(app: tauri::AppHandle) {
    // 闭包需要持有自己的 AppHandle 副本（'static 生命周期要求）
    let handle = app.clone();
    app.listen_any(EVT_OPEN_CHAT, move |_| show_chat(&handle));

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

    // 站立提醒弹窗（v0.7.0）：显示在宠物正上方（点击弹窗 = standup-ack）
    let handle = app.clone();
    app.listen_any(EVT_SHOW_ALERT, move |_| show_alert(&handle));

    // 服务端超时/重置也可收起弹窗，不能依赖用户一定会点击弹窗。
    let handle = app.clone();
    app.listen_any(EVT_HIDE_ALERT, move |_| {
        hide_legacy_alert(&handle);
    });

    let handle = app.clone();
    app.listen_any(EVT_STANDUP_ACK, move |_| {
        hide_legacy_alert(&handle);
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
/// user-idle 内部：Windows = GetLastInputInfo，macOS = CGEventSource 查询（均无需特殊权限）。
#[tauri::command]
fn get_idle_seconds() -> u64 {
    user_idle::UserIdle::get_time()
        .map(|idle| idle.as_seconds())
        .unwrap_or(0)
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

/// 把宠物窗放到主屏右下角（贴边留 24 逻辑像素边距）。
///
/// 坐标体系注意：monitor.size() / outer_size() 都是**物理像素**，
/// 而 margin 我们按逻辑像素设计，所以要乘 scale_factor 再取整。
/// 已知限制：Windows 任务栏在底部时宠物会悬浮在任务栏之上（alwaysOnTop），
/// v0.1.0 接受此行为，后续版本考虑改用工作区（work area）计算。
fn position_pet_bottom_right(app: &tauri::App) {
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
}
