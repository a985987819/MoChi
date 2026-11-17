import { createRoot } from "react-dom/client";
import { ChatApp } from "./ChatApp";
import { installGlobalErrorLogging } from "@/services/log";
import { installLocaleWatcher } from "@/shared/i18n/core";
import { installThemeWatcher } from "@/shared/theme";
import "@/shared/theme.css";

// 全局异常落盘（v0.16.0）：未捕获错误/拒绝进日志文件（release 无控制台）
installGlobalErrorLogging("chat");

// 主题监听（v0.18.0）：设置/系统深浅变化时切换本窗口的 data-theme
installThemeWatcher();
// 语言监听（v0.19.0）：settingsChanged 即时切换，不重启
installLocaleWatcher();

createRoot(document.getElementById("root")!).render(<ChatApp />);
