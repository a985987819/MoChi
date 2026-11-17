import { createRoot } from "react-dom/client";
import { AlertApp } from "./AlertApp";
import { installThemeWatcher } from "@/shared/theme";
import "@/shared/theme.css";

// 主题监听（v0.18.0）：提醒弹窗也跟随主题（弹窗是独立 WebView）
installThemeWatcher();

createRoot(document.getElementById("root")!).render(<AlertApp />);
