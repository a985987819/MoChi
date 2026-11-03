# Mochi 宠物素材命名约定

> 这是**你放置自定义宠物形象的唯一依据**。改约定必须同步 `src/services/pet-state.ts` / `pet-assets.ts` 并更新版本文档。
> 状态机设计（优先级/驱动方）见 `docs/learning/08-timers-reminders-presence.md` §2。

## 1. 放哪里

| 目录 | 说明 |
|---|---|
| `{应用数据目录}/pet-assets/` | **用户素材目录（推荐）**。Windows 示例：`C:\Users\<你>\AppData\Roaming\com.mochi.pet\pet-assets\`。放进去即生效，无需重启应用 |
| 应用内置 `src/assets/pet/` | 随应用打包的兜底形象（开发者在仓库里维护） |
| （运行时兜底） | 以上都没有时显示内置占位 SVG——宠物窗永不白屏 |

**优先级：用户目录 > 内置素材 > 占位 SVG**。同名状态只有优先级最高的那份生效。

## 2. 文件命名

```
{状态}.{扩展名}          基础形态，如 happy.gif、idle.png
{状态}_{序号}.{扩展名}    变体形态，如 idle_2.png、idle_3.png（序号从 2 开始）
```

- 支持扩展名：`png` `jpg` `jpeg` `gif` `webp` `svg`（大小写不敏感；`jpeg` 归一为 `jpg`）。
  用户目录与内置素材走同一套解析逻辑（前端 `src/services/pet-assets.ts` 的
  `SUPPORTED_EXTS`、Rust `list_user_pet_assets` 白名单一致，均含 `svg`）。
- `gif` / `webp` 动图会被当作**动画素材**：播放期间不参与变体轮换（播完自然循环）。
- 变体轮换：同一状态有多张**静态**图（png/jpg）时，每 5~9 秒随机换一张；只有一张则固定。
- 无法识别的文件名会被忽略；状态名超出下方状态集的文件暂时不会被触发（向前兼容，不会报错）。

## 3. 状态集（v1 全集，与 PetStateManager 一致）

| 状态名 | 含义 | 谁触发 |
|---|---|---|
| `idle` | 默认待机（不提供则用占位图） | 默认 |
| `happy` / `sad` | Agent 情绪：被夸 / 被批评 | 对话内容（v0.4.0 起） |
| `thinking` / `talking` | 模型推理中 / 回复输出中 | 应用自动（AgentEvent 映射） |
| `alert` | 站立提醒触发 | 站立计时器（v0.7.0） |
| `stretch` | 伸展奖励动画（点击提醒弹窗后） | 站立计时器（v0.7.0） |
| `focus` / `break` | 番茄钟专注 / 休息 | 番茄钟（v0.7.0） |
| `sleep` | 用户离开（无输入） | 在场检测（v0.7.0） |

触发优先级（高→低）：`alert` > `focus`/`break` > `sleep` > 情绪类 > `idle`。
即：你放一张 `focus.png` 后，番茄钟专注期间宠物会穿戴着它工作；提醒触发瞬间 `alert` 最高。

## 4. 尺寸与样式建议

- 宠物窗固定 **220×260**（透明背景），形象显示区域约 200×240，居中贴底；
- 建议**竖构图、底部对齐**（团子坐在窗底），透明背景 PNG/GIF 最佳；JPG 无透明通道会带白底方块，不推荐；
- 图片会以"完整显示、不裁剪"方式渲染（`object-fit: contain`）。

## 5. 快速验收（对应 roadmap v0.2.0）

1. 向用户目录放 `happy.gif` → 右键宠物 → 表情演示 → happy：播放你的 gif，无需重启；
2. 删掉该文件 → 再触发 happy：回落到内置/占位图，不白屏；
3. 放 `idle_2.png`、`idle_3.png` → idle 状态每几秒随机轮换；
4. 表情演示里先点 happy 再点 focus：focus 抢占（系统事件 > 情绪），8 秒后 happy 恢复、随后回落 idle。
