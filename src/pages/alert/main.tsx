import { createRoot } from "react-dom/client";
import { AlertApp } from "./AlertApp";
import { installLocaleWatcher } from "@/shared/i18n/core";
import { installThemeWatcher } from "@/shared/theme";
import "@/shared/theme.css";

// 主题监听（v0.18.0）：提醒弹窗也跟随主题（弹窗是独立 WebView）
installThemeWatcher();
// 语言监听（v0.19.0）：弹窗文案即时切换
installLocaleWatcher();

createRoot(document.getElementById("root")!).render(<AlertApp />);
