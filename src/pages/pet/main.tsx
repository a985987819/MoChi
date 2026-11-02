import { createRoot } from "react-dom/client";
import { PetApp } from "./PetApp";
import { petState } from "@/services/pet-state";
import { presenceService } from "@/services/presence";
import { standupService, pomodoroService } from "@/services/timers";
import { reminderScheduler } from "@/services/reminders";

// 跨窗口遥控监听（state://set-mood 等）只装一次：宠物窗是宠物状态的宿主窗口
void petState.installRemoteListeners();

// 常驻服务（v0.7.0，learning/08）：宠物窗是应用生命周期最长的宿主窗口
// （关闭=隐藏、进程常驻托盘），计时器/在场检测/提醒调度都驻留这里
void presenceService.start(); // 在场检测 → sleep 状态 + 提醒推迟的依据
void standupService.start(); // 站立提醒（监听 ui://reset-standup / standup-ack）
void pomodoroService.start(); // 番茄钟（监听 state://pomodoro-start/stop）
void reminderScheduler.start(); // 自然语言提醒调度（30s 轮询 SQLite 认领）

createRoot(document.getElementById("root")!).render(<PetApp />);
