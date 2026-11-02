import { createRoot } from "react-dom/client";
import { PetApp } from "./PetApp";
import { petState } from "@/services/pet-state";

// 跨窗口遥控监听（state://set-mood 等）只装一次：宠物窗是宠物状态的宿主窗口
void petState.installRemoteListeners();

createRoot(document.getElementById("root")!).render(<PetApp />);
