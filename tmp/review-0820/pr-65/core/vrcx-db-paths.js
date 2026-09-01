/**
 * VRCX 数据库路径探测（跨平台）
 *
 * 供 migrate-vrcx0.mjs（数据迁移）与 analyze-db.mjs（结构分析）等工具复用，
 * 避免平台路径逻辑在多处重复。
 *
 * 探测规则（按平台）:
 *   Windows: %USERPROFILE%\AppData\Roaming\VRCX[(-0)]\VRCX[(-0)].sqlite3
 *   macOS:   ~/Library/Application Support/VRCX/VRCX.sqlite3
 *   Linux:   ~/.config/VRCX/VRCX.sqlite3（原生 Electron 版）
 *            ~/.wine/drive_c/users/<user>/AppData/Roaming/VRCX/VRCX.sqlite3
 *            （Wine 运行 Windows 版；WINEPREFIX 环境变量可覆盖默认前缀 ~/.wine）
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function candidateVrcxDbPaths() {
  const home = os.homedir();
  const paths = [];
  const addHome = (...segs) => paths.push(path.join(home, ...segs));

  if (process.platform === 'win32') {
    addHome('AppData', 'Roaming', 'VRCX', 'VRCX.sqlite3');
    addHome('AppData', 'Roaming', 'VRCX-0', 'VRCX-0.sqlite3');
  } else if (process.platform === 'darwin') {
    addHome('Library', 'Application Support', 'VRCX', 'VRCX.sqlite3');
  } else {
    // Linux 及其他类 Unix
    // 原生 Electron 版 VRCX 使用 XDG 配置目录（.NET ApplicationData → ~/.config）
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    paths.push(path.join(configHome, 'VRCX', 'VRCX.sqlite3'));
    paths.push(path.join(configHome, 'VRCX-0', 'VRCX-0.sqlite3'));

    // Wine 运行 Windows 版 VRCX（WINEPREFIX 可覆盖，默认 ~/.wine）
    const prefixes = [process.env.WINEPREFIX, path.join(home, '.wine')].filter(Boolean);
    for (const prefix of prefixes) {
      const usersDir = path.join(prefix, 'drive_c', 'users');
      let users = [];
      try {
        users = readdirSync(usersDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        // 目录不存在则跳过
      }
      for (const user of users) {
        paths.push(path.join(usersDir, user, 'AppData', 'Roaming', 'VRCX', 'VRCX.sqlite3'));
        paths.push(path.join(usersDir, user, 'AppData', 'Roaming', 'VRCX-0', 'VRCX-0.sqlite3'));
      }
    }
  }
  return paths;
}

// 返回第一个实际存在的候选路径；都没有则返回 null
export function findVrcxDb() {
  for (const p of candidateVrcxDbPaths()) {
    if (existsSync(p)) return p;
  }
  return null;
}