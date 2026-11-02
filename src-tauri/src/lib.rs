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

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Listener, Manager, WindowEvent,
};

/// UI 事件名常量 —— 与 `src/shared/events.ts` 的 `UI_EVENTS` 一一对应。
/// 改名必须两边同步（TS 侧是 `as const` 对象，Rust 侧是这些常量）。
const EVT_OPEN_CHAT: &str = "ui://open-chat";
const EVT_HIDE_CHAT: &str = "ui://hide-chat";
const EVT_TOGGLE_PET: &str = "ui://toggle-pet";

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
        .plugin(tauri_plugin_opener::init());

    // macOS：桌宠类应用不应出现在 Dock 上（Accessory = 无 Dock 图标、无主窗口菜单）。
    // Windows 下此 API 不存在，用 cfg 条件编译隔离平台差异。
    #[cfg(target_os = "macos")]
    let builder = builder.set_activation_policy(tauri::ActivationPolicy::Accessory);

    builder
        .setup(|app| {
            setup_tray(app)?;
            setup_ui_event_listeners(app.handle().clone());
            position_pet_bottom_right(app);
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
    let x = monitor.size().width as i32 - win_size.width as i32 - margin;
    let y = monitor.size().height as i32 - win_size.height as i32 - margin;

    let _ = pet.set_position(tauri::PhysicalPosition::new(x, y));
}
