/**
 * 数据库自动备份模块（2026-08-09 新增）
 *
 * 用 better-sqlite3 的在线备份 API（db.backup）——WAL 模式下无需停服务，
 * 一致性备份。策略：
 * - 启动时做一次 + 每 24h 自动做一次（start-monitor.js 里定时触发）
 * - 保留最近 KEEP 份（默认 2），旧备份自动清理
 * - MCP 工具 backup_database 可随时手动触发
 */
import { mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import path from 'node:path';

const KEEP = 2;
const BACKUP_PREFIX = 'vrc-monitor-backup-';

/**
 * 备份数据库到 backupsDir，返回 { ok, path, size, kept, pruned }。
 * @param {import('better-sqlite3').Database} db
 * @param {string} backupsDir 备份目录（不存在自动创建）
 */
export async function backupDatabase(db, backupsDir) {
  if (!db || !db.backup) throw new Error('backupDatabase: 无效的数据库实例');
  mkdirSync(backupsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // YYYY-MM-DDTHH-MM-SS
  const dest = path.join(backupsDir, `${BACKUP_PREFIX}${stamp}.sqlite3`);

  await db.backup(dest);
  // 备份文件转 DELETE journal 模式（单文件自包含，恢复时无需伴生文件）
  try {
    const backupDb = new Database(dest);
    backupDb.pragma('journal_mode = DELETE');
    backupDb.close();
  } catch { /* 转换失败不阻塞备份流程 */ }
  // 清理可能残留的伴生文件
  try {
    unlinkSync(dest + '-wal');
    unlinkSync(dest + '-shm');
  } catch { /* 没有伴生文件就跳过 */ }
  const pruned = pruneOldBackups(backupsDir);
  return {
    ok: true,
    path: dest,
    size: statSync(dest).size,
    kept: KEEP,
    pruned,
    at: new Date().toISOString(),
  };
}

/**
 * 清理 backupsDir 中超过 KEEP 份的旧备份（按文件名时间戳排序，删最旧的）。
 * 返回被删除的文件名数组。
 */
export function pruneOldBackups(backupsDir, keep = KEEP) {
  let files;
  try {
    files = readdirSync(backupsDir).filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith('.sqlite3'));
  } catch {
    return [];
  }
  files.sort(); // 文件名带 ISO 时间戳，字典序 = 时间序
  const pruned = [];
  while (files.length > keep) {
    const old = files.shift();
    try {
      unlinkSync(path.join(backupsDir, old));
      pruned.push(old);
    } catch { /* 忽略删除失败 */ }
  }
  return pruned;
}
