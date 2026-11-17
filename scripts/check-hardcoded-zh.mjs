#!/usr/bin/env node
/**
 * 硬编码中文扫描（P2-03B / v0.19.0）—— i18n 迁移进度的清单工具。
 *
 * 用法：`pnpm lint:i18n`。扫描 src/ 下 ts/tsx 里的 CJK 字符串字面量，
 * 排除：i18n 目录（zh-CN.ts 是事实源）、测试文件、已建档的未迁移文件
 * （PENDING 数组——每迁移一个文件就从名单里删掉，最终清零）。
 *
 * 输出"文件 × 条数"汇总 + 总数；有未建档的新文件才退出非零。
 * （PENDING 里的存量不挡 CI——它们是已知债务；新增硬编码才是回归。）
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** 已建档未迁移的文件（从名单删除 = 迁移完成）。三类债务：
 *  ① UI 欠账（下一批迁移）：聊天窗正文区/设置页其余分区/素材页/更新页/引导/工具轨迹；
 *  ② 模型输入刻意中文（不迁移）：Agent 提示词与工具错误回传——模型输出以中文为主；
 *  ③ 服务层错误/日志文本（待集中到 error-text 后统一走 t）。 */
const PENDING = [
  // ① UI 欠账
  "src/services/pet-chatter-lines.ts",
  "src/services/pet-chatter-context.ts",
  "src/services/pet-chatter.ts",
  "src/services/timers.ts",
  "src/services/reminders.ts",
  "src/services/notifications.ts",
  "src/services/sound.ts",
  "src/rag/local-qa.ts",
  "src/agent/error-text.ts",
  "src/shared/bubble-text.ts",
  // ② 模型输入刻意中文（含工具描述/参数说明——发给 LLM 的协议文本，
  //    同义词表/分词器是 RAG 语料不是 UI）
  "src/rag/synonyms.ts",
  "src/rag/tokenizer.ts",
  "src/agent/tools/todo.ts",
  "src/agent/tools/reminder.ts",
  "src/agent/tools/health-search.ts",
  "src/agent/tools/pomodoro.ts",
  "src/agent/tools/food-search.ts",
  "src/agent/tools/validate-schema.ts",
  "src/agent/tools/remember.ts",
  "src/agent/tools/pet-state.ts",
  "src/agent/providers/presets.ts",
  "src/agent/providers/openai-compatible.ts",
  // ③ 服务层错误/日志文本（console/日志用途，不进 UI）
  "src/pages/pet/ContextMenu.tsx",
  "src/services/log.ts",
  "src/agent/core/context-builder.ts",
  "src/agent/core/prompt.ts",
  "src/agent/core/agent.ts",
  "src/agent/tools/registry.ts",
  "src/agent/providers/mock.ts",
  "src/agent/providers/index.ts",
  "src/agent/memory/history-store.ts",
  "src/shared/addressing.ts",
  // ③ 服务层错误/日志文本
  "src/services/settings.ts",
  "src/services/tts.ts",
  "src/services/db.ts",
  "src/services/backup.ts",
  "src/services/autostart.ts",
  "src/services/pomodoro-control.ts",
  "src/services/system-events.ts",
  "src/services/host-services.ts",
  "src/services/pet-asset-import.ts",
  "src/services/pet-assets.ts",
  "src/services/alerts.ts",
  "src/services/app-updates.ts",
  "src/services/heartbeat.ts",
  "src/services/presence.ts",
  "src/services/pet-state.ts",
  "src/services/settings-debounce.ts",
  "src/services/storage.ts",
  "src/services/quiet-hours.ts",
  "src/services/service-scope.ts",
  "src/pages/chat/app-updates.css",
  "src/pages/pet/PetApp.tsx",
  "src/pages/pet/menu-position.ts",
  "src/pages/pet/gestures.ts",
  "src/shared/show-transition.ts",
  "src/shared/events.ts",
];

const CJK = /[\u4e00-\u9fff]/;
/** 跳过的目录与文件模式 */
const SKIP_DIRS = ["__tests__", "i18n", "node_modules", "dist"];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full).split(sep).join("/");
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.some(d => rel.includes(d))) out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push({ rel, full });
    }
  }
  return out;
}

/** 数一段代码里的 CJK 字符串字面量（含模板串；注释里的中文不算——注释是文档） */
function countCjkLiterals(source) {
  let count = 0;
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  for (const m of withoutComments.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    if (CJK.test(m[2])) count += 1;
  }
  return count;
}

const files = walk(ROOT + "src");
const report = new Map();
let unknownNew = 0;

for (const { rel, full } of files) {
  const count = countCjkLiterals(readFileSync(full, "utf8"));
  if (count === 0) continue;
  const isKnownDebt = PENDING.includes(rel) || rel.startsWith("src/shared/i18n/");
  if (!isKnownDebt) unknownNew += count;
  report.set(rel, { count, known: isKnownDebt });
}

console.log("== 硬编码中文清单（迁移进度）==");
let total = 0;
for (const [rel, { count, known }] of [...report].sort((a, b) => b[1].count - a[1].count)) {
  total += count;
  console.log(`${known ? "  " : "!!"} ${rel}: ${count} 处${known ? "" : "（未建档！)"}`);
}
console.log(`共 ${total} 处，其中未建档 ${unknownNew} 处（!! 行）`);
console.log("已迁移完成的界面：Tab 栏 / 提醒中心 / 待办 / 番茄钟 / 提醒弹窗 / 右键菜单 / 设置·语言区");
if (unknownNew > 0) {
  console.error("\n发现未建档的硬编码中文——要么迁移，要么把它加进本脚本的 PENDING 名单。");
  process.exit(1);
}
