/**
 * SQLite 接入单例 —— 规格：docs/learning/04-memory.md §3.1（五表 DDL 的唯一权威定义）。
 *
 * 选型说明：DDL 用 TS 侧 ensureSchema 幂等创建（CREATE TABLE IF NOT EXISTS），
 * 而非 plugin-sql 的 config migrations——顺序执行建表对教学项目更透明、零配置 schema 风险；
 * 表结构若演进，加 ALTER 迁移步骤并同步 04 文档。
 *
 * 参数占位符是 plugin-sql 的 $1/$2 风格（04 §3.2）。
 */

import Database from "@tauri-apps/plugin-sql";

export type Db = Database;

let dbReady: Promise<Db> | null = null;

/** 获取已建好五表的数据库连接（各窗口单例，SQL 文件共享） */
export function getDb(): Promise<Db> {
  dbReady ??= (async () => {
    const db = await Database.load("sqlite:mochi.db"); // 落 appDataDir
    for (const ddl of SCHEMA) await db.execute(ddl);
    await migrateReminderAcknowledgements(db);
    return db;
  })().catch(error => {
    // 磁盘忙/插件尚未就绪属于可恢复失败，不能把 rejected Promise 永久当作连接缓存。
    // 同一轮并发调用仍等待同一个 Promise；下一次调用重新连接并幂等建表。
    dbReady = null;
    throw error;
  });
  return dbReady;
}

/**
 * 旧库的 fired 原本表示“已经通知”，升级时按已确认处理，避免历史提醒整批轰炸。
 * 新记录从列默认 NULL 开始：派发后仍可在重启时恢复，直到用户真正确认。
 */
async function migrateReminderAcknowledgements(db: Db): Promise<void> {
  const columns = await db.select<Array<{ name: string }>>("PRAGMA table_info(reminders)");
  if (!columns.some(column => column.name === "acknowledged_at")) {
    try {
      // -1 是旧行的迁移哨兵；新建提醒显式写 NULL，不能被历史回填误标为已确认。
      await db.execute("ALTER TABLE reminders ADD COLUMN acknowledged_at INTEGER DEFAULT -1");
    } catch (error) {
      // 两窗口可以同时开库；另一个窗口已完成 ALTER 不算迁移失败。
      const current = await db.select<Array<{ name: string }>>("PRAGMA table_info(reminders)");
      if (!current.some(column => column.name === "acknowledged_at")) throw error;
    }
  }
  // 即便上次 ALTER 后回填遇到锁定，下次开库也会继续处理 -1，避免历史记录被误重放。
  await db.execute(
    "UPDATE reminders SET acknowledged_at = CASE WHEN status = 'fired' THEN COALESCE(fired_at, created_at) ELSE NULL END WHERE acknowledged_at = -1",
  );
}

/**
 * 五表 DDL（learning/04 §3.1 逐字段说明）：
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
     fired_at   INTEGER,
     acknowledged_at INTEGER
   )`,
];
