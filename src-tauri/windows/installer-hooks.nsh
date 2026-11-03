; ─────────────────────────────────────────────────────────────────────────────
; Mochi 安装器钩子（Tauri `bundle.windows.nsis.installerHooks` 指向本文件）
;
; 为什么需要这个文件：
; Tauri 生成的 NSIS 完成页只有一个「运行 Mochi」勾选框，用户装完之后对
; 「麻薯在哪、怎么用、去哪配 API Key」一无所知。安装器是用户接触产品的
; 第一屏，这里做两件事：① 用 MUI 定义覆盖欢迎页/完成页文案，按步骤中文
; 介绍「安装会做什么、装完先做什么」；② 补一份中文「快速上手」落在安装
; 目录。配合应用内首次启动引导（src/pages/chat/WelcomeGuide.tsx）形成
; 两层指引：
;   安装器层  → 明确「会装什么、装好了东西在哪」
;   应用层    → 手把手带过第一轮交互
;
; 注意：本文件必须以 UTF-8 with BOM 保存（Tauri 模板 `Unicode true`），
; 否则 NSIS 会把中文按 ANSI 解析成乱码。
; ─────────────────────────────────────────────────────────────────────────────
;
; ── 向导页中文步骤引导（v0.8.1 第二次会话）────────────────────────────────
; 为什么写在 hook 文件里就能改向导页文案：
; Tauri 模板的 include 顺序是  include MUI2.nsh → include 本文件
;   → 定义 MUI 页面（MUI_PAGE_WELCOME 等）→ 插入语言。MUI2 的页面宏
; 在 `!insertmacro MUI_PAGE_*` 执行时才读取 MUI_WELCOMEPAGE_TEXT 等定义，
; 所以只要在「页面宏之前」定义即可覆盖默认文案——本文件的 include 点
; 恰好满足。这比复制整个 installer.nsi 模板轻量得多（v0.8.1 取舍：不跟
; 模板漂移）。代价：这两条是静态文案，不随系统语言变化——本项目已把
; 安装器强制为简中（tauri.conf.json languages 只留 SimpChinese），
; 静态中文与该决策自洽，反而消除了任何语言回退的不确定性。
; ─────────────────────────────────────────────────────────────────────────────

; 欢迎页：把「安装会做什么」讲成步骤，替代 NSIS 通用文案
; （默认只有「此向导将指引你完成安装，建议关闭其他所有程序」，
; 用户对装到哪、要不要管理员、数据存哪一无所知）。
!define MUI_WELCOMEPAGE_TEXT "本向导将通过以下三步完成安装：$\r$\n$\r$\n　① 选择安装位置 —— 默认只为当前用户安装，无需管理员权限$\r$\n　② 创建开始菜单与桌面快捷方式$\r$\n　③ 写入《快速上手》指南，并可选择立即启动麻薯$\r$\n$\r$\n聊天记录、待办等数据保存在 %APPDATA%\com.mochi.pet，升级或卸载都不会丢失。$\r$\n$\r$\n单击〔下一步〕继续。"

; 完成页：把「装完先干什么」讲成步骤，并把自定义形象的放置规则直接给到
; （路径 + 「文件名＝状态名」命名法 + 支持的格式 + 立即生效）。这是用户问得
; 最多的「放什么图、放哪里」，不该藏在 txt 里。正文显示在两个勾选框上方，
; 行数必须克制，否则会把「创建桌面快捷方式 / 运行 Mochi」挤下去。
; 素材约定的事实源是 docs/pet-assets.md：路径 %APPDATA%\com.mochi.pet\pet-assets\，
; {状态}.{扩展名} / {状态}_{序号}.{扩展名}，扩展名 png/jpg/jpeg/gif/webp/svg
; （与 src/services/pet-assets.ts、src-tauri list_user_pet_assets 一致）。
!define MUI_FINISHPAGE_TEXT "麻薯安装完成！$\r$\n$\r$\n　① 首次启动会自动弹出新手引导，跟着走即可$\r$\n　② 换形象（可选）：把图片放进 %APPDATA%\com.mochi.pet\pet-assets\，$\r$\n　　 文件名＝状态名，如 idle.png（待机）、happy.gif（开心）、focus.png（专注）；$\r$\n　　 支持 png / jpg / gif / webp / svg，放进去立即生效、无需重启$\r$\n　③ 完整状态表与变体规则见安装目录《快速上手.txt》$\r$\n$\r$\n勾选「运行 Mochi」并单击〔完成〕，和麻薯见个面。"

!macro NSIS_HOOK_POSTINSTALL
  ; 安装进度页的过程提示：让「正在做什么」全程可见（DetailPrint 显示在
  ; 进度列表里；此处是纯字面量，不依赖 LangString，无语言回退问题）。
  DetailPrint "正在写入《快速上手》指南..."
  ; 文件写入放在 POSTINSTALL：此时 $INSTDIR 已存在、快捷方式已创建，
  ; 写失败也不影响安装结果（NSIS 的 FileWrite 不抛错，只是文件缺失）。
  FileOpen $9 "$INSTDIR\快速上手.txt" w
  FileWriteUTF16LE $9 "Mochi（麻薯） 安装完成 —— 快速上手$\r$\n"
  FileWriteUTF16LE $9 "========================================$\r$\n"
  FileWriteUTF16LE $9 "$\r$\n"
  FileWriteUTF16LE $9 "一、麻薯在哪$\r$\n"
  FileWriteUTF16LE $9 "  安装完成后会自动启动。麻薯待在屏幕右下角，是一个透明的小窗口，$\r$\n"
  FileWriteUTF16LE $9 "  不占任务栏位置。如果没看到它，看系统托盘（任务栏右下角的小图标区），$\r$\n"
  FileWriteUTF16LE $9 "  左键单击托盘图标即可显示 / 隐藏麻薯。$\r$\n"
  FileWriteUTF16LE $9 "$\r$\n"
  FileWriteUTF16LE $9 "二、三个基本操作$\r$\n"
  FileWriteUTF16LE $9 "  · 按住拖动：把麻薯拖到屏幕任意位置。$\r$\n"
  FileWriteUTF16LE $9 "  · 双击麻薯：打开聊天窗口（待办 / 番茄钟 / 设置都在里面）。$\r$\n"
  FileWriteUTF16LE $9 "  · 右键麻薯：弹出菜单（打开聊天、隐藏、表情演示、退出）。$\r$\n"
  FileWriteUTF16LE $9 "  · 单击麻薯：它会弹一下，同时把「该站起来了」的计时清零重置。$\r$\n"
  FileWriteUTF16LE $9 "$\r$\n"
  FileWriteUTF16LE $9 "三、配置 AI（可选，但不配只能用 Mock 演示）$\r$\n"
  FileWriteUTF16LE $9 "  聊天窗口 → 设置 → 提供商选 DeepSeek → 粘贴 API Key → 点「测试连通性」。$\r$\n"
  FileWriteUTF16LE $9 "  Key 只保存在本机，不会上传到任何服务器。$\r$\n"
  FileWriteUTF16LE $9 "$\r$\n"
  FileWriteUTF16LE $9 "四、它还能做什么（直接对它说话）$\r$\n"
  FileWriteUTF16LE $9 "  · 待办：  「帮我加个待办：明天九点开周会」$\r$\n"
  FileWriteUTF16LE $9 "  · 番茄钟：「来个番茄钟」/「停下番茄钟」$\r$\n"
  FileWriteUTF16LE $9 "  · 提醒：  「半小时后提醒我喝水」$\r$\n"
  FileWriteUTF16LE $9 "  · 热量：  「巨无霸多少热量」$\r$\n"
  FileWriteUTF16LE $9 "  · 站立提醒：默认每 60 分钟提醒一次，间隔可在设置里改。$\r$\n"
  FileWriteUTF16LE $9 "$\r$\n"
  FileWriteUTF16LE $9 "五、换成你自己的形象$\r$\n"
  FileWriteUTF16LE $9 "  把图片放进这个目录，文件名就是状态名，放进去立刻生效（无需重启）：$\r$\n"
  FileWriteUTF16LE $9 "    %APPDATA%\com.mochi.pet\pet-assets\$\r$\n"
  FileWriteUTF16LE $9 "  例如 idle.png、happy.gif、focus.png；同状态的多个变体写成 idle_2.png。$\r$\n"
  FileWriteUTF16LE $9 "  支持的格式：png / jpg / gif / webp / svg。$\r$\n"
  FileWriteUTF16LE $9 "$\r$\n"
  FileWriteUTF16LE $9 "六、数据与卸载$\r$\n"
  FileWriteUTF16LE $9 "  聊天记录 / 待办 / 记忆都存在 %APPDATA%\com.mochi.pet\，$\r$\n"
  FileWriteUTF16LE $9 "  升级或卸载都不会清空；想彻底删除请手动删除该目录。$\r$\n"
  FileWriteUTF16LE $9 "  卸载：Windows 设置 → 应用 → 已安装的应用 → Mochi → 卸载。$\r$\n"
  FileWriteUTF16LE $9 "$\r$\n"
  FileWriteUTF16LE $9 "遇到问题或有想法：https://github.com/a985987819/MoChi/issues$\r$\n"
  FileClose $9
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载前不做任何数据清理：用户数据目录（%APPDATA%\com.mochi.pet）刻意保留，
  ; 这样重装后聊天记录、待办、自定义素材都还在（v0.8.0 已实测）。
!macroend
