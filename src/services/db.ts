/**
 * SQLite 接入单例 —— 规格：docs/learning/04-memory.md §3.1（四表 DDL 的唯一权威定义）。
 *
 * 选型说明：DDL 用 TS 侧 ensureSchema 幂等创建（CREATE TABLE IF NOT EXISTS），
 * 而非 plugin-sql 的 config migrations——四条语句对教学项目更透明、零配置 schema 风险；
 * 表结构若演进，加 ALTER 迁移步骤并同步 04 文档。
 *
 * 参数占位符是 plugin-sql 的 $1/$2 风格（04 §3.2）。
 */

import Database from "@tauri-apps/plugin-sql";

export type Db = Database;

let dbReady: Promise<Db> | null = null;

/** 获取已建好四表的数据库连接（全应用单例） */
export function getDb(): Promise<Db> {
  dbReady ??= (async () => {
    const db = await Database.load("sqlite:mochi.db"); // 落 appDataDir
    for (const ddl of SCHEMA) await db.execute(ddl);
    return db;
  })();
  return dbReady;
}

/**
 * 四表 DDL（learning/04 §3.1 逐字段说明）：
 * - sessions：v1 只用单会话（id='main'），表结构先行，多会话是 v2 空间；
 * - messages：存协议原样（tool_calls JSON 整存）——恢复即用、无信息损失；
 * - todos：v0.5.0 从 todos.json 迁入；
 * - memories：一条事实一行（粒度即检索单位）；
 * - reminders：v0.7.0 自然语言提醒（fire_at=epoch ms 绝对时间，learning/08 §5.4）。
 */
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id          TEXT PRIMARY KEY,
     title       TEXT NOT NULL DEFAULT '新对话',
     created_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id   TEXT NOT NULL,
     role         TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
     content      TEXT,
     tool_calls   TEXT,
     tool_call_id TEXT,
     created_at   INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS todos (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     title      TEXT NOT NULL,
     due        TEXT,
     done       INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     done_at    INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS memories (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     fact       TEXT NOT NULL,
     source     TEXT NOT NULL DEFAULT 'user',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS reminders (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     text       TEXT NOT NULL,
     fire_at    INTEGER NOT NULL,
     status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','fired','cancelled')),
     created_at INTEGER NOT NULL,
     fired_at   INTEGER
   )`,
];