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

use std::collections::BTreeMap;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Listener, Manager, WindowEvent,
};
use tauri_plugin_window_state::{StateFlags, WindowExt};

/// UI 事件名常量 —— 与 `src/shared/events.ts` 的 `UI_EVENTS` 一一对应。
/// 改名必须两边同步（TS 侧是 `as const` 对象，Rust 侧是这些常量）。
const EVT_OPEN_CHAT: &str = "ui://open-chat";
const EVT_HIDE_CHAT: &str = "ui://hide-chat";
const EVT_TOGGLE_PET: &str = "ui://toggle-pet";
const EVT_QUIT_APP: &str = "ui://quit-app";
const EVT_SHOW_ALERT: &str = "ui://show-alert";
const EVT_STANDUP_ACK: &str = "ui://standup-ack";
/// 气泡（v0.9.0 P1-01）：前端 emit 带文本载荷，Rust 定位 + 原样转发给 bubble 窗
const EVT_SHOW_BUBBLE: &str = "ui://show-bubble";
const EVT_HIDE_BUBBLE: &str = "ui://hide-bubble";
/// Rust → bubble 窗的转发事件名（与 events.ts 的 BRIDGE_EVENTS.bubbleText 对应）
const EVT_BUBBLE_TEXT: &str = "bubble://text";

/// 应用入口：组装 Tauri Builder（插件 → 托盘 → 事件 → 窗口行为）后进入事件循环。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // single-instance 必须最先注册：第二次启动进程时，回调在「已有实例」里执行
    let builder = tauri::Builder::default()
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
        .invoke_handler(tauri::generate_handler![list_user_pet_assets, get_idle_seconds]);

    // macOS：桌宠类应用不应出现在 Dock 上（Accessory = 无 Dock 图标、无主窗口菜单）。
    // Windows 下此 API 不存在，用 cfg 条件编译隔离平台差异。
    #[cfg(target_os = "macos")]
    let builder = builder.set_activation_policy(tauri::ActivationPolicy::Accessory);

    builder
        .setup(|app| {
            setup_tray(app)?;
            setup_ui_event_listeners(app.handle().clone());
            ensure_pet_position(app);
            Ok(())
        })
        // 拦截所有窗口的关闭请求 → 隐藏。Tauri 中窗口关闭默认会销毁窗口对象，
        // 隐藏则保留对象，之后 show() 零成本恢复（状态都在）。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
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

    // 右键菜单「退出」（托盘菜单直接调 app.exit，不走事件）
    let handle = app.clone();
    app.listen_any(EVT_QUIT_APP, move |_| handle.exit(0));

    // 站立提醒弹窗（v0.7.0）：显示在宠物正上方（点击弹窗 = standup-ack）
    let handle = app.clone();
    app.listen_any(EVT_SHOW_ALERT, move |_| show_alert(&handle));

    let handle = app.clone();
    app.listen_any(EVT_STANDUP_ACK, move |_| {
        if let Some(alert) = handle.get_webview_window("alert") {
            let _ = alert.hide();
        }
    });

    // 宠物气泡（v0.9.0 P1-01）：Rust 是纯路由——把 ui://show-bubble 的文本载荷
    // 原样转给 bubble 窗（bubble://text），自己不解析、不缓存业务文本
    let handle = app.clone();
    app.listen_any(EVT_SHOW_BUBBLE, move |event| show_bubble(&handle, &event));

    let handle = app.clone();
    app.listen_any(EVT_HIDE_BUBBLE, move |_| {
        if let Some(bubble) = handle.get_webview_window("bubble") {
            let _ = bubble.hide();
        }
    });
}

/// 把提醒弹窗显示到宠物正上方居中处（learning/08 §4.2）。
/// 几何逻辑复用 position_above_pet；点击 ack 后由 EVT_STANDUP_ACK 监听隐藏。
fn show_alert(app: &tauri::AppHandle) {
    let (Some(alert), Some(pet)) = (app.get_webview_window("alert"), app.get_webview_window("pet")) else {
        return;
    };
    position_above_pet(&pet, &alert, 12);
    let _ = alert.show();
}

/// 宠物气泡显示（v0.9.0 P1-01）：定位到宠物正上方 → 转发文本 → show。
/// 载荷原样转发（前端 emit 的 JSON 字符串）——本函数不解析文本内容，
/// 因此 Rust 侧永远不持有业务文本（气泡窗隐藏后状态自然消失）。
fn show_bubble(app: &tauri::AppHandle, event: &tauri::Event) {
    let (Some(bubble), Some(pet)) = (app.get_webview_window("bubble"), app.get_webview_window("pet")) else {
        return;
    };
    position_above_pet(&pet, &bubble, 8);
    use tauri::Emitter;
    let _ = bubble.emit(EVT_BUBBLE_TEXT, event.payload());
    let _ = bubble.show();
}

/// 把 window 定位到宠物正上方居中处（gap = 与宠物顶边的间隙，物理像素）。
/// alert（提醒弹窗）与 bubble（对话气泡）共用同一几何规则——都是"从宠物头上长出来"。
/// 几何全取物理像素：宠物位置/尺寸 + 目标窗 outer_size。
fn position_above_pet(pet: &tauri::WebviewWindow, win: &tauri::WebviewWindow, gap: i32) {
    if let (Ok(pet_pos), Ok(pet_size), Ok(win_size)) =
        (pet.outer_position(), pet.outer_size(), win.outer_size())
    {
        let x = pet_pos.x + (pet_size.width as i32 - win_size.width as i32) / 2;
        let y = pet_pos.y - win_size.height as i32 - gap;
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
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
    position_pet_bottom_right(app);
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

/// 把宠物窗放到主屏右下角（贴边留 24 逻辑像素边距）。
///
/// 坐标体系注意：monitor.size() / outer_size() 都是**物理像素**，
/// 而 margin 我们按逻辑像素设计，所以要乘 scale_factor 再取整。
/// v0.9.0 P0-04：Windows 优先用工作区（扣除任务栏后的可见区域，SPI_GETWORKAREA）
/// 计算——旧版用整屏高度，宠物会悬浮在任务栏之上；拿不到工作区时退回整屏算法
/// （macOS 保持整屏算法：菜单栏/Dock 需 NSScreen.visibleFrame，留待后续版本）。
fn position_pet_bottom_right(app: &tauri::App) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(win_size) = pet.outer_size() else {
        return;
    };

    #[cfg(target_os = "windows")]
    if let Some(area) = primary_work_area() {
        let margin = (24.0 * pet.primary_monitor().ok().flatten().map_or(1.0, |m| m.scale_factor()).round()) as i32;
        let x = area.0 + area.2 - win_size.width as i32 - margin;
        let y = area.1 + area.3 - win_size.height as i32 - margin;
        let _ = pet.set_position(tauri::PhysicalPosition::new(x, y));
        return;
    }

    // 工作区不可用（或 macOS）：退回整屏算法
    let Ok(Some(monitor)) = pet.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let margin = (24.0 * scale).round() as i32;
    let x = monitor.size().width as i32 - win_size.width as i32 - margin;
    let y = monitor.size().height as i32 - win_size.height as i32 - margin;
    let _ = pet.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 主屏工作区（x, y, w, h，物理像素）——Windows 用 SPI_GETWORKAREA 查询。
/// 返回 None 表示查询失败（调用方回退整屏算法）。
/// DPI 注意：Tauri 清单声明 PerMonitorV2，进程对主屏坐标系是物理像素视角，
/// 与 monitor.size() 同一体系，无需再乘 scale。
#[cfg(target_os = "windows")]
fn primary_work_area() -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };

    let mut rect = RECT::default();
    let ok = unsafe {
        // SPI_GETWORKAREA：主屏工作区（扣除任务栏）；pvParam 传 RECT 指针；
        // fWinIni 传 0 = 不广播 WM_SETTINGCHANGE（只读查询）
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some((&mut rect as *mut RECT).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    if ok.is_ok() && rect.right > rect.left && rect.bottom > rect.top {
        Some((rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top))
    } else {
        None
    }
}
