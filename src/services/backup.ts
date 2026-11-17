/**
 * 备份服务（P2-02 / v0.17.0）—— 前端编排 + Rust 文件操作。
 *
 * 职责边界（learning/07 应用边界）：文件系统/zip 全在 Rust（前端没有文件系统
 * 权限）；本模块只做两件事——
 * 1. **导出前的 WAL checkpoint**：写连接在聊天窗（plugin-sql 的连接池归前端），
 *    `PRAGMA wal_checkpoint(TRUNCATE)` 必须从持有连接的一侧执行；Rust 侧只拷文件。
 *    这是尽力而为：checkpoint 与其他窗口的读并发冲突时会返回 busy——导出的数据
 *    最多落后几秒（提醒写入是毫秒级事件），不为此阻塞导出。
 * 2. invoke 封装与类型收窄（收方校验：Rust 返回的列表逐字段验证）。
 */

import { invoke } from "@tauri-apps/api/core";
import { getDb } from "@/services/db";
import { logWarn } from "@/services/log";

/** 备份清单条目（list_backups 返回） */
export interface BackupInfo {
  name: string;
  sizeBytes: number;
  modifiedMs: number;
}

/** 收方校验：Rust 返回的条目逐字段验证（脏数据降级为跳过） */
function asBackupInfo(raw: unknown): BackupInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.name !== "string" ||
    typeof r.sizeBytes !== "number" ||
    typeof r.modifiedMs !== "number" ||
    !Number.isFinite(r.sizeBytes) ||
    !Number.isFinite(r.modifiedMs)
  ) {
    return null;
  }
  return { name: r.name, sizeBytes: r.sizeBytes, modifiedMs: r.modifiedMs };
}

/**
 * 列出备份目录的 zip（修改时间倒序，Rust 侧排好）。读取失败抛错给 UI 展示，
 * 不静默——列表是导入的唯一入口，静默空列表会让用户以为"没有备份"。
 */
export async function listBackups(): Promise<BackupInfo[]> {
  const raw = await invoke<unknown[]>("list_backups");
  return raw.map(asBackupInfo).filter((b): b is BackupInfo => b !== null);
}

/**
 * 导出备份（zip 落 `{appData}/backups/mochi-YYYYMMDD-HHmmSS.zip`）。
 * 返回完整路径，UI 用于 reveal 与展示。
 */
export async function exportBackup(includeKeys: boolean): Promise<string> {
  // 导出前把 WAL 落回主库（见模块注释的尽力而为语义）
  try {
    const db = await getDb();
    await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    // checkpoint 失败不阻塞导出：数据最多落后几秒，如实留痕
    logWarn("backup", `WAL checkpoint 未完成（导出继续，数据可能略有滞后）: ${error instanceof Error ? error.message : String(error)}`);
  }
  return invoke<string>("export_backup", { includeKeys });
}

/**
 * 导入备份（覆盖三数据源）。返回 Rust 的人类可读结果（含 pre-restore 文件名）。
 * 调用方负责确认交互与"重启生效"提示。
 */
export async function importBackup(path: string): Promise<string> {
  return invoke<string>("import_backup", { path });
}

/** 备份目录路径（设置页展示 + reveal 用） */
export async function backupsDir(): Promise<string> {
  const { appDataDir } = await import("@tauri-apps/api/path");
  const sep = navigator.userAgent.includes("Windows") ? "\\" : "/";
  return `${await appDataDir()}${sep}backups`;
}

/** 字节数人话化（列表显示；纯函数供测试与未来复用） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
