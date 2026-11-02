# 06 · 前端工程师视角的 Tauri 2：多窗口桌宠架构

> 对应版本：v0.1.0 ｜ 学完标准：能脱稿画出 Mochi 的窗口/进程/通信图，并能从空目录写出同构骨架。

## 1. 目标

- 建立 Tauri 2 的正确心智模型：**它不是 Electron**——Rust 是宿主进程，每个窗口是一个系统 WebView，前端只是被 WebView 加载的页面。
- 掌握桌宠应用的四件套：**透明无边框窗口、托盘常驻、单实例、关闭即隐藏**。
- 掌握多窗口应用的**页面组织**（多 HTML 入口）与**通信协议**（事件方向、命名、职责边界）。

## 2. 核心概念

### 2.1 Tauri 2 的进程与窗口模型

```
┌─ 操作系统 ────────────────────────────────────────┐
│  Mochi.exe（Rust 宿主进程 = "main process"）        │
│   ├── tauri::Builder 事件循环（托盘/全局快捷键/插件）  │
│   ├── Window#pet   ── WebView2 ── 加载 index.html   │
│   ├── Window#chat  ── WebView2 ── 加载 chat.html    │
│   └── Window#alert ── WebView2 ── 加载 alert.html   │
└───────────────────────────────────────────────────┘
```

与 Electron 的关键差异：

| | Electron | Tauri 2 |
|---|---|---|
| 宿主 | Chromium + Node.js（随应用分发，~100MB+） | Rust 二进制 + 系统 WebView（Win 用 WebView2，mac 用 WKWebView） |
| 前端运行时 | 每窗口一个渲染进程 | 每窗口一个系统 WebView 实例（共享系统组件） |
| IPC | Electron ipcMain/ipcRenderer | Tauri **事件**（广播）与 **command**（请求-响应） |
| 权限 | 无内建（靠自觉） | **capability/permission 白名单**，前端能调什么 API 要显式声明 |

**心智模型**：把 Rust 侧想成一个"本地后端服务器"，但通信不走 HTTP，而是走 Tauri 的 IPC。窗口 = 浏览器标签页，每个标签页加载不同 HTML。

### 2.2 窗口三要素：label / url / 窗口选项

每个窗口有唯一 **label**（`pet` / `chat` / `alert`），它是窗口的"身份证"：

- Rust 侧：`app.get_webview_window("pet")` 按 label 取窗口句柄；
- capability 里 `"windows": ["pet", "chat", "alert"]` 按 label 授权；
- 事件监听里可按来源区分。

窗口声明在 `tauri.conf.json` 的 `app.windows` 数组，启动时自动创建。本项目的关键字段：

| 字段 | 宠物窗取值 | 作用 / 原理 |
|---|---|---|
| `url` | `index.html` / `chat.html` / `alert.html` | 相对路径；dev 下拼到 `devUrl`（localhost:1420），build 下从 `frontendDist` 找文件 |
| `transparent` | `true` | 窗口背景透明。**必须配合前端 CSS `html/body background: transparent`**，两层都透明才真的透 |
| `decorations` | `false` | 去掉系统标题栏/边框（无边框窗口） |
| `alwaysOnTop` | `true` | 置顶 |
| `skipTaskbar` | `true` | 不占任务栏格子 |
| `shadow` | `false` | 关闭窗口投影——透明窗若开 shadow，Windows 会给**矩形窗口轮廓**画出阴影，穿帮 |
| `focus` | `false` | 启动时不抢焦点（桌宠礼仪：静静出现，不打断你） |
| `resizable` | `false` | 固定尺寸 |

**macOS 专属**：透明窗口需要 `app.macOSPrivateApi: true`（调用 WKWebView 私有 API，Mac App Store 不收此类应用，自分发无碍）；去 Dock 图标需要在 Rust 里 `set_activation_policy(Accessory)`。

### 2.3 事件系统：方向与命名

Tauri 事件是**全局广播**：任何一端 `emit`，所有窗口和 Rust 监听者都能收到。

```
前端 → Rust：emit("ui://open-chat")      Rust 用 app.listen_any 接
Rust → 前端：app.emit("state://changed")  前端用 listen() 接
前端 → 前端：emit(...)                    都能收到（广播）
```

Mochi 的命名约定（写在两边代码里并保持同步）：

- `ui://<动作>` —— UI 发起，请求 Rust 做系统操作；
- `state://<变化>` —— 服务/Agent 发起，通知前端更新（v0.2.0 起大量使用）。

**业界规范对照**：这等价于 Web 前端里的"事件总线 + 语义化事件名"。规范化命名的原因：事件是隐式耦合（没有编译期检查），前缀约定是唯一可搜索、可 review 的防线。

### 2.4 托盘（Tray）与单实例

- **托盘**：`TrayIconBuilder` + `Menu::with_items`。菜单项有 `id`，`on_menu_event` 按 id 分发。`show_menu_on_left_click(false)` 让左键留给单击行为（切换宠物显示），右键弹菜单。
- **单实例**：`tauri_plugin_single_instance::init(callback)`——**必须第一个注册**。第二次启动时新进程会把参数转交给已有进程的回调然后退出。回调里我们把宠物窗 show 出来（用户再次双击图标 = "我要看到麻薯"）。

### 2.5 关闭 ≠ 退出：`CloseRequested` 拦截

窗口关闭默认销毁窗口。桌宠/常驻应用的通行做法：

```rust
.on_window_event(|window, event| {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();   // 拒绝销毁
        let _ = window.hide(); // 降级为隐藏，进程驻留托盘
    }
})
```

配合托盘菜单里 `app.exit(0)` 作为**唯一**真正退出入口。这是 QQ/微信式生命周期的标准实现。

## 3. 业界规范与常见做法

1. **窗口管理归后端**。前端不持有窗口控制权（capability 最小化），一切"显示/隐藏/聚焦"由 Rust 执行，前端只发事件。类比：Web 里前端不该能直接操作服务器进程。
2. **UI 事件语义化 + 集中定义**。事件名常量两边各存一份（TS `UI_EVENTS` / Rust `EVT_*`），改名必须同步——低成本换取可 grep、可 review。
3. **透明窗口三件套**：`transparent: true`（窗口层）+ CSS `background: transparent`（页面层）+ `shadow: false`（防穿帮）。缺一不可，这是桌宠类应用最高频的翻车点。
4. **物理像素 vs 逻辑像素**：涉及显示器/窗口几何时，Tauri 的 `Monitor::size()`、`outer_size()`、`set_position(PhysicalPosition)` 全是**物理像素**；margin 这类"设计值"是逻辑像素，必须 `× scale_factor` 换算。
5. **CSP 从第一天就配置**：`default-src 'self'` 起步，后续功能（img data:、LLM API https:）逐项加白，而不是最后再补。

## 4. 本项目实现走读

### 4.1 多入口页面组织（前端）

三个窗口 = 三个 HTML 入口（`index.html` / `chat.html` / `alert.html`），各自由 `src/pages/<名>/main.tsx` 挂载 React。Vite 需要 `build.rollupOptions.input` 列出三个入口（vite.config.ts），否则 build 只打 index。

注意两个工程细节：

1. `"type": "module"` 下 vite.config.ts 是 ESM，没有 `__dirname`，用 `path.dirname(fileURLToPath(import.meta.url))` 推导；
2. TS 6 弃用 `baseUrl`，`paths` 直接写相对 tsconfig 的路径（`"@/*": ["./src/*"]`），并与 vite `resolve.alias` 保持一致。

共享代码放 `src/shared/`（事件常量、占位组件），页面私有代码放各自目录——**页面之间不互相 import**，只通过事件通信，这是多窗口应用的解耦关键。

### 4.2 宠物窗 UI（src/pages/pet/）

- 整个舞台 `<main data-tauri-drag-region>`：Tauri 往页面注入的脚本会拦截该元素上的左键 mousedown 并调用原生 `start_dragging`，于是"按住哪里都能拖"。双击事件不受影响（拖动只在按住移动时生效）。
- 单击弹跳：`setBouncing(false)` → `requestAnimationFrame(() => setBouncing(true))` 强制重启 CSS 动画（React 里重播动画的惯用技巧），`onAnimationEnd` 复位。
- 待机漂浮 `mochi-float`：transform 轻微位移 + 挤压（scale 0.99/1.01），麻薯的"呼吸感"。
- `MochiPlaceholder` 是内联 SVG（无外部资源、无 CSP 顾虑）；v0.2.0 起它降级为素材回退链的最后一环。

### 4.3 Rust 骨架（src-tauri/src/lib.rs）

Builder 组装顺序即执行顺序，逐段看：

```rust
tauri::Builder::default()
  .plugin(tauri_plugin_single_instance::init(|app, ..| { show pet }))  // ① 必须最先
  .plugin(tauri_plugin_opener::init())
  // ② macOS: Accessory 无 Dock 图标（cfg 隔离平台差异）
  .setup(|app| {
      setup_tray(app)?;                       // ③ 托盘
      setup_ui_event_listeners(app.handle()); // ④ ui:// 事件 → 窗口操作
      position_pet_bottom_right(app);         // ⑤ 宠物右下角定位
      Ok(())
  })
  .on_window_event(|window, event| { /* ⑥ CloseRequested → hide */ })
  .run(tauri::generate_context!())            // ⑦ 进入事件循环
```

关键实现细节：

- **`listen_any` vs `listen`**：AppHandle 上两者都监听全局事件，`listen_any` 不做来源过滤，语义上更贴合"应用级监听"。
- **闭包持有 AppHandle**：`listen_any` 的回调是 `'static`，必须 `let handle = app.clone(); app.listen_any(..., move |_| ...)` —— AppHandle 是廉价引用计数克隆（Arc），这是 Tauri 代码的标准姿势。
- **show vs show+set_focus**：宠物窗 show 时不夺焦（不打断用户打字）；聊天窗 show 后要 `set_focus()`（要接输入）。
- **右下角定位**：物理像素计算 `x = monitor.width - win.width - margin*scale`，见 §3.4。

### 4.4 权限声明（capabilities/default.json）

```json
{ "windows": ["pet", "chat", "alert"], "permissions": ["core:default", "opener:default"] }
```

`core:default` 只含事件、拖动区等基础能力。注意：**没有任何窗口 show/hide/close 权限**——前端想隐藏聊天窗只能发 `ui://hide-chat` 事件，由 Rust 执行。这就是 §3.1 的落地。

## 5. 设计取舍

| 决策 | 为什么 | 放弃了什么 |
|---|---|---|
| 窗口管理放 Rust（事件驱动） | 权限最小化 + 逻辑单一来源 | 前端直接调 window API 更"顺手"，但会把窗口逻辑散落三处 |
| 关闭 = 隐藏，托盘退出 | 桌宠/常驻工具的通行生命周期；聊天窗状态免重建 | 用户"关掉"≠"退出"，需要在 README/菜单里说明（托盘右键有退出） |
| chat 窗用系统标题栏 | v0.1.0 控制范围 | 自绘标题栏更精致 → v0.3.0 做设置 UI 时一并升级 |
| 多 HTML 入口而非单页路由切换 | 窗口间完全隔离，无路由状态泄漏；符合"一个窗口一个页面"的系统直觉 | 共享组件要进公共 chunk（体积略增，可忽略） |
| 占位形象用内联 SVG | 零资源依赖、天然适配透明窗、无 CSP 问题 | 造型简陋 → v0.2.0 素材系统是正解 |
| CSP 现在就收紧 | 安全习惯从第一个版本建立 | 开发期改 CSP 麻烦一点 |

## 6. 复盘自测（合上文档，逐条默写）

1. 画出 Mochi 的进程/窗口/通信图：宿主进程里有什么？三个窗口各加载什么？事件从哪到哪？
2. 从空目录写出一个透明置顶宠物窗的最小 `tauri.conf.json` 窗口声明（label/url/尺寸/五个关键开关）。
3. 透明窗口为什么"三层都要透明"？少了 `shadow: false` 会看到什么穿帮？
4. 默写 `CloseRequested` 拦截为隐藏的 Rust 代码（含 `api.prevent_close()`）。
5. 单实例插件的回调运行在**哪个进程**里？为什么它必须第一个注册？
6. 解释 `position_pet_bottom_right` 里为什么 margin 要乘 `scale_factor`。
7. 前端 `emit("ui://open-chat")` 之后，消息经过哪些环节最终让聊天窗显示并聚焦？
8. capability 里不给前端 window show/hide 权限，前端如何实现"关闭聊天窗"？为什么这样设计？

（答案全部在上文；答不出的条目回 §2/§4 对应小节重读。）

## 7. 延伸阅读

- Tauri 官方：窗口自定义（透明/装饰）https://v2.tauri.app/learn/window-customization/
- Tauri 官方：系统托盘 https://v2.tauri.app/learn/system-tray/
- Tauri 官方：Capabilities 与权限 https://v2.tauri.app/security/capabilities/
- 源码对照：`src-tauri/tauri.conf.json`、`src-tauri/src/lib.rs`、`src/shared/events.ts`
