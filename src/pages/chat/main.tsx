import { createRoot } from "react-dom/client";
import { ChatApp } from "./ChatApp";
import { installGlobalErrorLogging } from "@/services/log";

// 全局异常落盘（v0.16.0）：未捕获错误/拒绝进日志文件（release 无控制台）
installGlobalErrorLogging("chat");

createRoot(document.getElementById("root")!).render(<ChatApp />);
