/**
 * VRChat 好友监控系统 — 主入口
 * 
 * 独立 MCP 服务（不依赖 VRCX-0）
 * 提供 WebSocket 实时监控 + SQLite 存储 + MCP 工具服务
 * 
 * 启动: node start-monitor.js
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

import { ctx, log, refreshWatchlistCache } from './core/server-context.js';
import { recordOpsLog, setOpsLogSink } from './core/ops-log.js';
import * as registry from './core/registry.js';
import { isSafeModeEnabled, DESTRUCTIVE_TOOLS } from './core/safe-mode.js';
import { Storage } from './core/storage.js';
import { RateLimiter } from './core/rate-limiter.js';
import { VrchatApiClient } from './vrchat-api.js';
import { WsManager } from './core/ws-manager.js';
import { EventPipeline } from './core/event-pipeline.js';
import { FriendStateManager } from './core/friend-state.js';
import { createServer } from './core/http-server.js';
import { PluginLoader } from './core/plugin-loader.js';
import { registerDashboardServices } from './core/dashboard-services.js';
import { migrateLegacyData } from './core/migrate-legacy-data.js';
import { fetchOtpFromEmail } from './core/otp-fetcher.js';
import {
  getCreators, addCreator, removeCreator,
  scanCreatorWorlds, getWorldDigest,
} from './core/fetch-x-worlds.js';
import {
  handleScanNewWorlds, handleGetNewWorlds, handleRateWorld, handleMarkWorldVisited,
  handleSetWorldSleep,
  handleAddToBacklog, handleGetBacklog, handleRemoveFromBacklog, handleSearchWorlds,
} from './core/tools/misc.js';
import {
  handleGetFavoriteFriendsLocations, handleSetJoinPreference, handleGetJoinPreference,
  handleRecordJoinChoice, handleGetJoinLearning, handleRecommendJoin,
} from './core/tools/recommend.js';
import { handleRecommendWorlds } from './core/tools/recommend-worlds.js';
import { parseTotpSecret, generateTotp } from './core/totp.js';
import { notifier } from './core/notifier.js';
import { buildChannels } from './core/notify-channels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env 加载（只取 VRC_MONITOR_*）──
// 注意：无条件覆盖 process.env——服务被插件 spawn 时可能继承旧值，跳过会导致 .env 配置失效
// 个人配置（分组权重/联系人名单/DB 路径等）放仓库根 .env（.gitignore 已忽略），不硬编码进代码
try {
  const envFile = path.join(__dirname, '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && m[1].startsWith('VRC_MONITOR_')) {
        process.env[m[1]] = m[2];
      }
    }
  }
} catch (e) { /* .env 加载失败不阻断 */ }

// ── 路径常量 → 写入 ctx.paths ──
// DB / 备份目录 / Cookie / 凭据可通过环境变量覆盖（Docker 部署时由 compose 显式传入）
const rawPort = parseInt(process.env.VRC_MONITOR_PORT || '8799', 10);
const PORT = Number.isNaN(rawPort) || rawPort <= 0 || rawPort > 65535 ? 8799 : rawPort;
const HOST = process.env.VRC_MONITOR_HOST || '127.0.0.1';
const COOKIE_FILE = process.env.VRC_MONITOR_COOKIE_FILE || path.join(__dirname, 'data', 'auth_cookie.txt');
const CRED_FILE = process.env.VRC_MONITOR_CRED_FILE || path.join(__dirname, 'credentials.json');
const NOTIFY_FILE = path.join(__dirname, 'notify-config.json');
const DB_PATH = process.env.VRC_MONITOR_DB_PATH
  ? path.resolve(process.env.VRC_MONITOR_DB_PATH)
  : path.join(__dirname, 'data', 'vrc-monitor.sqlite3');
const BACKUP_DIR = process.env.VRC_MONITOR_BACKUP_DIR
  ? path.resolve(process.env.VRC_MONITOR_BACKUP_DIR)
  : path.join(__dirname, 'data', 'backups');
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每 24h 自动备份

Object.assign(ctx.paths, { __dirname, PORT, HOST, COOKIE_FILE, CRED_FILE, DB_PATH, BACKUP_DIR, BACKUP_INTERVAL_MS });

// ── WebSocket 事件 → 好友状态更新 ──
async function _updateFriendState(event) {
  const { friendState } = ctx;
  switch (event.type) {
    case 'friend-online':
      friendState.setOnline(event.userId, {
        displayName: event.displayName,
        location: event.location,
        worldId: event.worldId,
      });
      break;
    case 'friend-offline':
      friendState.setOffline(event.userId);
      break;
    case 'friend-location':
      friendState.updateLocation(event.userId, {
        displayName: event.displayName,
        location: event.location,
        worldId: event.worldId,
      });
      break;
    case 'friend-active':
      friendState.setOnline(event.userId);
      break;
  }
}

// ── WebSocket 重连后刷新全量在线状态 ──
async function _refreshOnlineState() {
  const { api, friendState, storage } = ctx;
  try {
    // offline=false = 仅返回在线+active 好友（docs vrchat.community /reference/get-friends；
    // 注意 offline=true 是「仅离线」，不是全量）。分页拉全，任何一页失败则放弃本轮对账（防误标）
    const online = [];
    let offset = 0, complete = false;
    for (let i = 0; i < 6; i++) {
      const r = await api._request('GET', `/auth/user/friends?offline=false&n=100&offset=${offset}`);
      if (r.status !== 200 || !Array.isArray(r.data)) break; // complete 保持 false → 跳过本轮对账
      online.push(...r.data);
      if (r.data.length < 100) { complete = true; break; }
      offset += r.data.length;
    }
    if (!complete) { log('⚠️ 刷新在线状态: 好友列表未拉全，跳过本轮对账'); return; }

    friendState.batchSetOnline(online.map(f => ({
      userId: f.id,
      displayName: f.displayName,
      location: f.location || '',
      worldId: f.worldId || (f.location || '').split(':')[0],
      // 在线口径与 MCP get_online_friends 一致：仅「有有效 location」计在线（offline=false 返回含
      // active/菜单中用户，location 为空者不算在线——issue #114 ⚠️2 复测遗留修复）
      isOnline: !!(f.location && f.location !== 'offline'),
    })));

    // 断线窗口对账：WS 断开期间的好友下线事件会错过（下线不再广播），本地状态会卡在「在线」。
    // 好友表标记在线、但不在真实在线集合中的 → 置离线 + 补记 friend-offline 事件（动态流可见）。
    // 准确下线时刻在断线窗口内无法得知，记对账时刻。
    const onlineIds = new Set(online.map(f => f.id));
    const stale = storage.query(`SELECT user_id, display_name, last_seen FROM friends WHERE is_online = 1`);
    const nowIso = new Date().toISOString();
    // API 掉线窗口起点 = WS 最近一次断开时刻（重连对账的「期间」语义）
    const disconnectedAt = ctx.wsManager && ctx.wsManager.disconnectedAt
      ? new Date(ctx.wsManager.disconnectedAt).toISOString() : '';
    let fixed = 0;
    for (const row of stale) {
      if (onlineIds.has(row.user_id)) continue;
      storage.upsertFriend({
        userId: row.user_id,
        isOnline: false,
        location: 'offline',
        lastSeen: nowIso,
        lastOffline: nowIso,
      });
      // 去重：重连风暴期 WS 实时下线可能已先入账（窗口内已有该好友的 offline 事件）→ 只修状态不补事件
      try {
        const since = disconnectedAt || new Date(Date.now() - 10 * 60_000).toISOString();
        const dup = storage.query(
          `SELECT id FROM events WHERE type = 'friend-offline' AND user_id = $uid AND created_at >= $since LIMIT 1`,
          { $uid: row.user_id, $since: since }
        );
        if (dup.length) { fixed++; continue; }
      } catch { /* 去重查询失败按无重复处理 */ }
      try {
        storage.insertEvent({
          type: 'friend-offline',
          userId: row.user_id,
          displayName: row.display_name || '',
          contentJson: {
            userId: row.user_id, location: 'offline',
            reconcile: true,
            offlineWindowStart: disconnectedAt,   // API 掉线起点（WS 断开时刻）
            detectedAt: nowIso,                    // 对账确认离线时刻
            lastSeen: row.last_seen || '',         // 好友最后活动时刻（更紧的下界）
          },
          worldId: '',
          worldName: '',
          createdAt: nowIso,
          source: 'api_poll',
        });
      } catch { /* 补事件失败不影响状态对账 */ }
      fixed++;
    }
    log(`🔄 刷新在线状态: 在线 ${online.length} 人${fixed ? `，断线窗口对账补离线 ${fixed} 人` : ''}`);
  } catch (err) {
    log(`⚠️ 刷新在线状态失败: ${err.message}`);
  }
}

// ── 好友头像/信任等级补全（低频）：拉全量好友列表，补齐头像为空或 trustLevel 缺失的（VRChat 对部分用户不返回 trustLevel 字段，但 tags 里有 system_trust_* 标记）
function inferTrustFromTags(tags) {
  // 对齐 VRCX computeTrustLevel（src/shared/utils/userTransforms.js）：system_trust_veteran→Trusted User / trusted→Known User / known→User / basic→New User
  const t = Array.isArray(tags) ? tags : [];
  if (t.includes('system_trust_veteran')) return 'Trusted User';
  if (t.includes('system_trust_trusted')) return 'Known User';
  if (t.includes('system_trust_known')) return 'User';
  if (t.includes('system_trust_basic')) return 'New User';
  return '';
}
async function _syncFriendAvatars() {
  const { api, rateLimiter, storage } = ctx;
  if (!api || !rateLimiter) return;
  let updated = 0;
  try {
    // 全量好友 = offline=false（在线+active）∪ offline=true（离线）——docs 实测：不传参数仅返回在线（2/13），
    // offline=true 仅离线（11/13）。旧实现只拉 offline=true，在线好友的头像/信任等级永远补不到。
    for (const flag of ['false', 'true']) {
    let offset = 0;
    for (let i = 0; i < 10; i++) {
      const r = await rateLimiter.execute(() => api._request('GET', `/auth/user/friends?offline=${flag}&n=100&offset=${offset}`));
      if (r.status !== 200 || !Array.isArray(r.data) || !r.data.length) break;
      for (const f of r.data) {
        // 模型 ID ↔ 图片映射：VRChat WS 推送的 friend-update 不含 currentAvatar（只有图片 URL），
        // 这里用全量好友列表建 imageUrl→avatarId 映射，供 events 服务富化模型变动事件的 avtr ID
        const fm = String(f.currentAvatarImageUrl || '').match(/\/file\/(file_[a-f0-9-]+)/);
        if (fm && f.currentAvatar) {
          try { storage.setPlanetCache(`avimg:${fm[1]}`, { avatarId: f.currentAvatar, at: Date.now() }); } catch { /* 落盘失败忽略 */ }
        }
        // VRChat API User 对象：头像字段 currentAvatarImageUrl/currentAvatarThumbnailImageUrl/userIcon，信任等级 trustLevel
        const av = f.currentAvatarImageUrl || f.currentAvatarThumbnailImageUrl || '';
        const ic = f.userIcon || '';
        const tl = f.trustLevel || inferTrustFromTags(f.tags);
        if (!av && !ic && !tl) continue;
        const ex = storage.getFriend(f.id);
        // issue #127 补漏：好友列表 API 响应带 f.displayName，但此前 upsert 未传 displayName，
        // 离线好友（无 WS 事件带名字）的 display_name 永远为空 → 前端显示 '?'。故：
        // ① 跳过条件要求 display_name 也已填（否则名字空的好友被 continue 漏掉）；
        // ② upsert 补传 displayName，下次头像同步即回填离线好友名字。
        if (ex && (ex.avatar_image_url || ex.user_icon) && ex.trust_level && ex.display_name) continue; // 头像+信任等级+display_name 都有则不覆盖
        storage.upsertFriend({ userId: f.id, displayName: f.displayName, avatarImageUrl: av, userIcon: ic, trustLevel: tl });
        updated++;
      }
      offset += r.data.length;
      if (r.data.length < 100) break;
    }
    }
    if (updated) log(`🖼️ 好友头像补全: 更新 ${updated} 人（全量=在线+离线双列表）`);
  } catch (err) {
    log(`⚠️ 好友头像补全失败: ${err.message}`);
  }
}

// ── 追踪非好友（VRCX-Luo 对齐）──
// VRChat 任何用户的 bio/status/头像都是公开的（GET /users/{id}），
// 非好友不推 WS 事件，只能定时拉取 diff 记录变化；同时用拉到的头像回填历史事件。
async function _seedTrackedNonFriends() {
  try {
    // 自己 userId：优先事件推导（user-location/user-update 只会是自己的事件，启动早期即可用），
    // /auth/user 在启动早期可能失败导致自己被误导入（2026-08-30 用户反馈）
    let selfId = ctx.storage.query(
      `SELECT user_id FROM events WHERE type IN ('user-location', 'user-update') AND user_id LIKE 'usr_%' LIMIT 1`
    )[0]?.user_id || '';
    const me = await ctx.rateLimiter.execute(() => ctx.api._request('GET', '/auth/user')).catch(() => null);
    if (me && me.status === 200 && me.data && me.data.id) selfId = me.data.id || selfId;
    // 启动清理：移除历史误导入的自己
    if (selfId) {
      const del = ctx.storage.run(`DELETE FROM tracked_non_friends WHERE user_id = $u`, { $u: selfId });
      if (del.changes > 0) log(`🧹 追踪列表移除误导入的自己（${selfId.slice(0, 12)}…）`);
    }
    // 自动导入上限（issue #114 ⚠️3 复测遗留修复）：仅导入近 30 天出现过的非好友，最多 100 人——
    // 长历史全量导入会数百上千行，每小时逐人拉资料触发 VRChat 限流；手动添加不受此限
    const rows = ctx.storage.query(
      `SELECT user_id, MAX(display_name) AS dn FROM events
       WHERE user_id LIKE 'usr_%' AND user_id != ''
         AND created_at >= datetime('now', '-30 days')
       GROUP BY user_id
       LIMIT 100`
    );
    let added = 0;
    for (const r of rows) {
      if (r.user_id === selfId) continue;                 // 排除自己
      if (ctx.storage.getFriend(r.user_id)) continue;     // 排除当前好友
      // 已移除追踪的用户不再重新导入（removed_at 标记，INSERT OR IGNORE 不覆盖）
      const wasRemoved = ctx.storage.query(
        `SELECT user_id FROM tracked_non_friends WHERE user_id = $u AND removed_at != ''`,
        { $u: r.user_id });
      if (wasRemoved.length) continue;
      ctx.storage.run(
        `INSERT OR IGNORE INTO tracked_non_friends (user_id, display_name) VALUES ($u, $d)`,
        { $u: r.user_id, $d: r.dn || '' }
      );
      added++;
    }
    if (added) log(`⭐ 追踪非好友: 自动导入 ${added} 人（历史非好友，定时拉取资料/头像）`);
  } catch (e) {
    log(`⚠️ 追踪非好友初始化失败: ${e.message}`);
  }
}

let _trackedRefreshRunning = false;  // 手动/定时刷新并发闸（防重复 diff 事件）

async function _refreshTrackedNonFriends() {
  const { api, rateLimiter, storage } = ctx;
  if (!api || !rateLimiter) return;
  const list = storage.query(`SELECT * FROM tracked_non_friends WHERE removed_at = ''`);
  if (!list.length) return;
  let ok = 0;
  for (const u of list) {
    try {
      const r = await rateLimiter.execute(() => api._request('GET', `/users/${encodeURIComponent(u.user_id)}`));
      if (r.status !== 200 || !r.data || r.data.error) continue;
      const userObj = r.data;
      const av = userObj.currentAvatarImageUrl || userObj.currentAvatarThumbnailImageUrl || userObj.userIcon || '';
      const dn = userObj.displayName || u.display_name || '';
      // 头像变化检测：按 file id 归一化比较（防 currentAvatarImageUrl vs Thumbnail 兜底链或 URL 版本号 /1/ vs /3/ 波动误报）
      const prevAv = u.avatar_image_url || '';
      const fileIdOf = (url) => { const m = String(url || '').match(/\/file\/(file_[a-f0-9-]+)/); return m ? m[1] : ''; };
      const changed = fileIdOf(av) && fileIdOf(prevAv) ? fileIdOf(av) !== fileIdOf(prevAv) : (av !== prevAv);
      if (av && prevAv && changed) {
        try {
          storage.insertEvent({
            type: 'friend-update', userId: u.user_id, displayName: dn || u.display_name || '',
            contentJson: { userId: u.user_id, displayName: dn || u.display_name || '', type: 'avatar', avatarImageUrl: av, previousAvatarImageUrl: prevAv },
            worldId: '', worldName: '', createdAt: new Date().toISOString(), source: 'poll',
          });
          log(`⭐ 追踪非好友头像变化: ${dn || u.user_id}`);
        } catch { /* 记录失败不影响刷新 */ }
      }
      const st = userObj.status || '';
      const stDesc = userObj.statusDescription || '';
      const loc = userObj.location || '';
      if (av || dn || st) {
        storage.run(
          `UPDATE tracked_non_friends SET avatar_image_url=$a, display_name=$d, status=$s, status_description=$sd, location=$l, last_refresh_at=datetime('now') WHERE user_id=$u`,
          { $a: av, $d: dn, $s: st, $sd: stDesc, $l: loc, $u: u.user_id }
        );
      }
      _recordNonFriendChange(u.user_id, dn, userObj, av);
      // 回填历史事件头像（之前没存头像的事件，如 VRCX 迁移数据）
      if (av) {
        try {
          storage.run(
            `UPDATE events SET content_json = json_set(COALESCE(content_json,'{}'), '$.avatarImageUrl', $a)
             WHERE user_id = $u AND (
               json_extract(content_json, '$.avatarImageUrl') IS NULL
               OR json_extract(content_json, '$.avatarImageUrl') = ''
             )`,
            { $a: av, $u: u.user_id }
          );
        } catch { /* 个别 JSON 解析失败忽略 */ }
      }
      ok++;
    } catch { /* 404/网络错误跳过，非致命 */ }
  }
  if (ok) log(`⭐ 追踪非好友刷新: ${ok}/${list.length} 位已更新`);
}

// 对照 events 表该用户最新 bio/status 事件，变化则记录（事件带头像）
function _recordNonFriendChange(userId, displayName, userObj, av) {
  const { storage } = ctx;
  const curBio = userObj.bio || '';
  const lastBio = storage.query(
    `SELECT content_json, created_at FROM events WHERE user_id=$u AND type='friend-update'
     AND json_extract(content_json,'$.type')='bio' ORDER BY id DESC LIMIT 1`, { $u: userId });
  let prevBio = '';
  if (lastBio.length) { try { prevBio = (JSON.parse(lastBio[0].content_json).bio || ''); } catch { /* 脏数据忽略 */ } }
  // bio 刷屏防护：①unicode NFC 归一化比较（emoji/组合字符在不同刷新返回的字节不稳定，
  // 归一化后相等视为无变化）；②时间窗去重——同用户 5 分钟内已记录过 bio 事件则跳过
  // （VRChat 编辑 bio 时逐字保存，逐次抓取内容不同会高频产生事件）。
  // bio 刷屏彻底方案:过滤 U+FFFD 后剥离标点只比核心文字(乱码会随机吞字符,标点差异全忽略)——
  // 例: '最好的' vs '最好'+U+FFFD 剥离后都归一, emoji/冒号/空格差异不误判
  // 根源修复(Buffer chunk 解码)后乱码不再产生,此处只需 NFC 归一化(规范等价) + 防御性滤 U+FFFD,
  // 不做核心文字剥离——真实微小变化(标点/emoji 增减)也要记录
  const norm = (x) => String(x || '').replace(/\uFFFD/g, '').normalize('NFC');

  const bioChanged = norm(prevBio) !== norm(curBio);
  if (bioChanged) {
    const recent = lastBio[0] && lastBio[0].created_at;
    if (recent) {
      const dt = (new Date().getTime() - new Date(recent).getTime()) / 1000;
      if (dt >= 0 && dt < 300) return;  // 5 分钟内已有 bio 事件，跳过本次(仅防 VRChat 编辑中逐字保存连发)
    }
  }
  if (!lastBio.length || bioChanged) {
    storage.insertEvent({
      type: 'friend-update', userId, displayName,
      contentJson: { userId, displayName, type: 'bio', bio: curBio, previousBio: prevBio, avatarImageUrl: av },
      worldId: '', worldName: '', createdAt: new Date().toISOString(), source: 'poll',
    });
  }
  const valid = ['join me', 'active', 'ask me', 'busy'];
  const curStatus = valid.includes(userObj.status) ? userObj.status : '';
  if (curStatus) {
    const lastSt = storage.query(
      `SELECT content_json FROM events WHERE user_id=$u AND type='friend-update'
       AND json_extract(content_json,'$.type')='status' ORDER BY id DESC LIMIT 1`, { $u: userId });
    let prev = null;
    if (lastSt.length) { try { prev = JSON.parse(lastSt[0].content_json); } catch { /* 脏数据忽略 */ } }
    const prevStatus = prev ? (prev.status || '') : '';
    if (!lastSt.length || prevStatus !== curStatus) {
      storage.insertEvent({
        type: 'friend-update', userId, displayName,
        contentJson: {
          userId, displayName, type: 'status',
          status: curStatus,
          statusDescription: userObj.statusDescription || '',
          previousStatus: prevStatus,
          previousStatusDescription: prev ? (prev.statusDescription || '') : '',
          avatarImageUrl: av,
        },
        worldId: '', worldName: '', createdAt: new Date().toISOString(), source: 'poll',
      });
    }
  }
}

// ── 端口占用探测（net.connect 成功 = 已有进程监听）──
function isPortBusy(port, timeoutMs = 800) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); resolve(false); });
  });
}

// ── 核心数据服务容器（供官方插件 consume）──
function registerCoreServices(loader, ctx) {
  const whitelist = [
    'getGroupCached',
    'upsertGroupCache',
    'getGroupHeat',
    'setWorldFavorited',
    'getWorldName',
    'upsertWorld',
    'getZhTranslations',
    'getBoothItemCache',
    'upsertBoothItem',
    'listBoothItems',
    'recordBoothSearch',
    'getBoothSearches',
    'getPlanetCache',
    'setPlanetCache',
  ];
  for (const name of whitelist) {
    if (typeof ctx.storage[name] !== 'function') {
      log(`⚠️ 核心存储服务 ${name} 不存在，跳过`);
      continue;
    }
    const svc = `storage.${name}`;
    loader.services.set(svc, (...args) => ctx.storage[name](...args));
    loader.serviceOwners.set(svc, 'core');
  }

  // x-creators 服务（供插件 consume）
  const xSvcs = {
    'x.creators': () => ({ creators: getCreators(ctx.storage) }),
    'x.addCreator': ({ screen_name, name } = {}) => addCreator(ctx.storage, { screen_name, name }),
    'x.removeCreator': ({ screen_name } = {}) => removeCreator(ctx.storage, screen_name || ''),
    'x.worlds': ({ limit = 50 } = {}) => {
      const rows = ctx.storage.getAllXWorlds(limit);
      return {
        total: rows.length,
        worlds: rows.map(r => ({
          worldId: r.world_id,
          worldName: r.world_name,
          authorName: r.author_name,
          favorites: r.favorites,
          visits: r.visits,
          popularity: r.popularity,
          lastRecommendedAt: r.last_recommended_at,
          tweetCount: r.tweet_count,
        })),
      };
    },
    'x.scanCreators': () => scanCreatorWorlds(),
    'x.worldDigest': (args) => {
      const refArgs = args || {};
      if (refArgs.refresh) {
        return scanCreatorWorlds().then(() => getWorldDigest(args || {}));
      }
      return getWorldDigest(args || {});
    },
  };
  for (const [name, fn] of Object.entries(xSvcs)) {
    loader.services.set(name, fn);
    loader.serviceOwners.set(name, 'core');
  }

  // world-kb 服务（供插件 consume；handler 绑定 core/tools/misc.js，owner='core'）
  // searchWorlds 保留原 rateLimiter 包裹（工具条目层原有行为）
  const worldSvcs = {
    'world.scanNewWorlds': (args) => handleScanNewWorlds(args || {}),
    'world.getNewWorlds': (args) => handleGetNewWorlds(args || {}),
    'world.rateWorld': (args) => handleRateWorld(args || {}),
    'world.markWorldVisited': (args) => handleMarkWorldVisited(args || {}),
    'world.setWorldSleep': (args) => handleSetWorldSleep(args || {}),
    'world.addToBacklog': (args) => handleAddToBacklog(args || {}),
    'world.getBacklog': (args) => handleGetBacklog(args || {}),
    'world.removeFromBacklog': (args) => handleRemoveFromBacklog(args || {}),
    'world.searchWorlds': (args) => ctx.rateLimiter.execute(() => handleSearchWorlds(args || {})),
  };
  for (const [name, fn] of Object.entries(worldSvcs)) {
    loader.services.set(name, fn);
    loader.serviceOwners.set(name, 'core');
  }

  // 推荐域服务（供插件 consume；handler 绑定 core/tools/recommend.js / recommend-worlds.js，owner='core'）
  // 注意：recommend.js 的 handler 内部用 ctx + _query/_run/rateLimiter，完整保留实现，不加额外包裹。
  const recommendSvcs = {
    'recommend.favoriteFriendsLocations': (args) => handleGetFavoriteFriendsLocations(args || {}),
    'recommend.setJoinPreference': (args) => handleSetJoinPreference(args || {}),
    'recommend.getJoinPreference': (args) => handleGetJoinPreference(args || {}),
    'recommend.recordJoinChoice': (args) => handleRecordJoinChoice(args || {}),
    'recommend.getJoinLearning': (args) => handleGetJoinLearning(args || {}),
    'recommend.recommendJoin': (args) => handleRecommendJoin(args || {}),
    'recommend.recommendWorlds': (args) => handleRecommendWorlds(args || {}),
  };
  for (const [name, fn] of Object.entries(recommendSvcs)) {
    loader.services.set(name, fn);
    loader.serviceOwners.set(name, 'core');
  }

  // 群组信息解析服务（issue #118：缓存优先 + API 回填，供 events 插件等 consume）。
  // 复用 core/domains/cache-store.js 的 getGroupCached/upsertGroupCache（TTL 7 天，与周报一致），
  // 命中缓存零限流 API；未命中才经 rateLimiter 拉 /groups/{id} 并回填 group_cache。
  loader.services.set('groups.resolve', async ({ groupId, force = false } = {}) => {
    if (!groupId || !String(groupId).startsWith('grp_')) throw new Error('groupId 必填且以 grp_ 开头');
    const cached = ctx.storage.getGroupCached(groupId);
    const TTL = 7 * 24 * 60 * 60 * 1000;
    const _ct = Date.parse(String(cached.updated_at).replace(' ', 'T') + 'Z');
    if (!force && cached && cached.name && Number.isFinite(_ct) && (Date.now() - _ct) < TTL) {
      return {
        groupId,
        name: cached.name,
        description: cached.description || '',
        memberCount: cached.member_count || 0,
        iconUrl: cached.icon_url || '',
        source: 'cache',
      };
    }
    const r = await ctx.rateLimiter.execute(() => ctx.api._request('GET', `/groups/${encodeURIComponent(groupId)}`));
    if (r.status === 200 && r.data) {
      const d = r.data;
      ctx.storage.upsertGroupCache({
        groupId,
        name: d.name || '',
        description: d.description || '',
        memberCount: d.memberCount || 0,
      });
      return {
        groupId,
        name: d.name || '',
        description: d.description || '',
        memberCount: d.memberCount || 0,
        iconUrl: d.iconUrl || '',
        source: 'api',
      };
    }
    throw new Error(`groups.resolve 失败: ${r.status}`);
  });
  loader.serviceOwners.set('groups.resolve', 'core');

  // 群组缓存写服务（issue #118）：供插件把搜索/采集得到的群组信息回填 group_cache，
  // 让后续 groups.resolve 命中缓存。仅写 name/description/member_count（group_cache 无
  // icon_url 列，icon 暂不入缓存；活动自带 icon_url 不受影响）。
  loader.services.set('groups.cache', ({ groupId, name, description, memberCount } = {}) => {
    if (!groupId || !String(groupId).startsWith('grp_')) throw new Error('groupId 必填且以 grp_ 开头');
    ctx.storage.upsertGroupCache({ groupId, name: name || '', description: description || '', memberCount: memberCount || 0 });
    return { ok: true };
  });
  loader.serviceOwners.set('groups.cache', 'core');

  // 认证与网络配置服务（供 auth-guard 插件查询，owner='core'）
  loader.services.set('core.authConfig', () => ({
    token: process.env.VRC_MONITOR_AUTH_TOKEN || process.env.VRC_MONITOR_API_KEY || null,
    host: process.env.VRC_MONITOR_HOST || '127.0.0.1',
    port: parseInt(process.env.VRC_MONITOR_PORT || '8799', 10),
  }));
  loader.serviceOwners.set('core.authConfig', 'core');

  // 手动触发非好友资料刷新（tracked 视图「立即刷新」按钮；fire-and-forget，立即返回）。
  // 并发闸：模块级 _trackedRefreshRunning 防与每小时例行任务/连续点击并发——并发下两个任务读到
  // 相同旧头像/旧状态会重复插入 friend-update 事件（diff 只在串行下保证去重）
  loader.services.set('dashboard.refreshTracked', () => {
    if (_trackedRefreshRunning) return { ok: true, started: false, reason: 'already-running' };
    _trackedRefreshRunning = true;
    _refreshTrackedNonFriends()
      .catch(() => {})
      .finally(() => { _trackedRefreshRunning = false; });
    return { ok: true, started: true };
  });
  loader.serviceOwners.set('dashboard.refreshTracked', 'core');

}

// ── 启动 ──

async function main() {
  // 动态读取版本号（package.json，避免硬编码漂移）
  let APP_VERSION = 'unknown';
  try {
    APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version;
  } catch { /* 读不到则显示 unknown，不阻断启动 */ }
  console.log('══════════════════════════════════════════════');
  console.log(`  VRChat-Assistant v${APP_VERSION}`);
  console.log('══════════════════════════════════════════════\n');

  // 0. 端口预检：MCP 端口已被占用 → 立即退出（防双实例并存 → OTP 验证码互抢循环，issue #49）
  //    必须前置：认证+OTP 抓取/WebSocket 在 main() 靠后位置，若等 listen 阶段才发现端口冲突，
  //    第二个实例早已抢走/消费验证码，触发 VRChat 重复下发，造成邮箱验证码轰炸
  if (await isPortBusy(PORT)) {
    console.error('');
    console.error(`❌ 端口 ${PORT} 已被占用，检测到监控服务可能已在运行`);
    console.error('   为避免双实例并存互抢 OTP 验证码（造成邮箱验证码轰炸），本进程将退出。');
    console.error('   请先确认旧实例状态并结束残留进程后重启：');
    console.error('     Windows: netstat -ano | findstr 8799  或  tasklist | findstr node');
    console.error('     Linux:   ss -ltnp | grep 8799         或  ps aux | grep start-monitor');
    console.error('');
    process.exit(1);
  }

  ctx.serverState.started = new Date().toISOString();

  // 0b. 安全模式（VRC_MONITOR_SAFE_MODE=true）：启动即剔除破坏性工具，tools/list 不暴露、tools/call 拦截
  if (isSafeModeEnabled()) {
    log('\n🔒 安全模式已启用（VRC_MONITOR_SAFE_MODE=true）');
    log(`   已移除 ${DESTRUCTIVE_TOOLS.length} 个破坏性工具: ${DESTRUCTIVE_TOOLS.join(', ')}`);
  } else {
    log('\n🔓 安全模式未启用（VRC_MONITOR_SAFE_MODE 未设置或非 true）');
  }

  // 0c. 旧数据迁移（issue #103）：根目录旧文件 → data/
  migrateLegacyData(__dirname, path.join(__dirname, 'data'));

  // 1. 初始化数据库
  log('📦 初始化数据库...');
  ctx.storage = new Storage();
// 服务运维日志（ops_log）：认证/连接生命周期打点的落库出口
setOpsLogSink((kind, level, message) => {
  try { ctx.storage.insertOpsLog({ kind, level, message, createdAt: new Date().toISOString() }); } catch { /* 不影响主流程 */ }
});
  await ctx.storage.init(DB_PATH);
  const stats = ctx.storage.getStats();
  // 服务进程启动打点：必须在 storage.init（建表）与 sink 接线之后，否则静默失败
  recordOpsLog('ops', 'info', `服务进程启动（v${APP_VERSION}，部署/容器重建/手动重启）`);
  ctx.serverState.version = APP_VERSION;
  log(`   ✅ 数据库就绪: ${DB_PATH}`);
  log(`   📊 事件: ${stats.events} 条 | 好友: ${stats.friends} 位 | 世界缓存: ${stats.world_cache} 个`);
  refreshWatchlistCache();  // 初始化 watchlist 内存缓存

  // 2. 初始化 API 客户端
  log('\n🔑 初始化 API 客户端...');
  if (!existsSync(CRED_FILE)) {
    console.error('\n❌ 未找到 credentials.json — 无法登录 VRChat');
    console.error('');
    console.error('   请先完成配置：');
    console.error('   1. 复制 credentials.example.json 为 credentials.json');
    console.error('   2. 填入 VRChat 邮箱、密码、邮箱 IMAP 授权码（imap_auth_code）');
    console.error('   3. 配置说明详见仓库根目录 AGENTS.md');
    console.error('');
    process.exit(1);
  }
  let creds;
  try {
    creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  } catch (parseErr) {
    console.error(`\n❌ credentials.json 解析失败: ${parseErr.message}`);
    console.error('   请检查文件是否为合法 JSON（参考 credentials.example.json 模板）');
    process.exit(1);
  }
  if (!creds.email || !creds.password) {
    console.error('\n❌ credentials.json 缺少 email 或 password 字段');
    console.error('   请参考 credentials.example.json 补全配置');
    process.exit(1);
  }
  ctx.api = new VrchatApiClient(creds.email, creds.password);
  ctx.api.setOtpFetcher(fetchOtpFromEmail);  // 401 自动重认证时复用邮箱 OTP 抓取

  // 可选的 TOTP 自动登录（credentials.json 配置 totp_secret 后启用）
  // 服务用 RFC 6238 本地生成验证码，登录/401 重认证/WS 重连全程自动，无需手动 submit_totp
  let totpFetcher = null;
  if (creds.totp_secret) {
    try {
      const { secretBytes, digits, period, algorithm } = parseTotpSecret(creds.totp_secret);
      // 利用前后窗口容错（审核 #70 🟡 建议 2）：返回 [前窗口, 当前, 后窗口] 三窗口验证码，
      // 由 _autoTotpLogin 依次尝试，容忍时钟漂移/窗口轮换（getTotpCodes count=1）
      totpFetcher = () => {
        const counter = Math.floor(Math.floor(Date.now() / 1000) / period);
        return [counter - 1, counter, counter + 1].map((c) => generateTotp(secretBytes, c, { digits, algorithm }));
      };
      ctx.api.setTotpFetcher(totpFetcher);
      log(`   🔐 TOTP 自动登录已启用（digits=${digits}, period=${period}s, ${algorithm}，前后窗口容错）`);
    } catch (parseErr) {
      console.error(`   ⚠️ totp_secret 解析失败（${parseErr.message}）：TOTP 自动登录不可用，将回退手动 submit_totp`);
    }
  }

  // 登录状态主动通知（issue #69）：加载 notify-config.json，注册跨平台通道
  // 默认关闭（缺文件 / enabled:false），只在需人工介入/异常时通知，多次失败聚合去抖
  let notifyConfig = { enabled: false };
  try {
    if (existsSync(NOTIFY_FILE)) {
      notifyConfig = JSON.parse(readFileSync(NOTIFY_FILE, 'utf-8'));
    }
  } catch (cfgErr) {
    console.error(`   ⚠️ notify-config.json 解析失败（${cfgErr.message}），通知已关闭`);
    notifyConfig = { enabled: false };
  }
  notifier.configure(notifyConfig);
  for (const ch of buildChannels(notifyConfig)) {
    notifier.registerChannel(ch);
  }
  if (notifier.enabled) {
    log(`   🔔 登录状态主动通知已启用（通道: ${(notifyConfig.channels || []).join(', ') || '无'}，连续失败阈值 ${notifier.config.consecutiveFailThreshold}，间隔 ${notifier.config.minIntervalSec}s）`);
  }
  ctx.api.loadCookieFromFile(COOKIE_FILE);
  try {
    const user = await ctx.api.ensureAuthWithAutoOtp(fetchOtpFromEmail);
    ctx.serverState.authUser = { id: user.id, displayName: user.displayName };
    ctx.serverState.needsOtp = false;
    log(`   ✅ 已登录: ${user.displayName} (${user.id})`);
    ctx.api.saveCookieToFile(COOKIE_FILE);
  } catch (err) {
    ctx.serverState.needsOtp = false;
    ctx.serverState.needsTotp = !!err.needsTotp;
    if (err.needsTotp) {
      if (totpFetcher) {
        log(`   ⚠️ 账号需要 TOTP 验证码：已配置自动登录，将在认证冷却后自动重试（或调用 submit_totp 手动提交）`);
        notifier.notifyAuth('needsTotp', '账号需要 TOTP 验证码（已配置自动登录，若持续失败请检查 totp_secret 或手动提交）');
      } else {
        log(`   ⚠️ 账号启用 TOTP 两步验证：请调用 MCP 工具 submit_totp 提交当前验证码（或在 credentials.json 配置 totp_secret 启用自动登录）`);
        notifier.notifyAuth('needsTotp', '账号需要 TOTP 验证码，服务暂停——请调用 submit_totp 提交当前验证码');
      }
    } else {
      notifier.notifyAuth('otpFailed', `启动登录失败：${err.message}`);
    }
    log(`   ❌ 登录失败: ${err.message}`);
    // 不退出进程，让 MCP/WS 服务启动以便后续重试
  }

  // 3. 初始化限流器
  ctx.rateLimiter = new RateLimiter({ minInterval: 2600 });
  log(`\n⏱  限流器: 间隔 ${ctx.rateLimiter.minInterval}ms`);

  // 4. 初始化好友状态管理器
  ctx.friendState = new FriendStateManager();
  log(`\n👥 好友状态管理器就绪`);

  // 5. 初始化事件处理管道
  ctx.eventPipeline = new EventPipeline(ctx.storage, null);

  // 5.5 加载插件（失败不阻断核心启动）
  const pluginLoader = new PluginLoader({ registry, ctx, log, notifier });
  registerCoreServices(pluginLoader, ctx);
  registerDashboardServices(pluginLoader, ctx);
  await pluginLoader.loadAll();
  pluginLoader.watch();
  ctx.pluginLoader = pluginLoader;
  log(` 插件系统就绪`);
  log(`📨 事件处理管道就绪`);

  // 6. 启动 WebSocket
  log('\n🔌 启动 WebSocket 连接...');
  ctx.wsManager = new WsManager({
    apiClient: ctx.api,
    otpFetcher: fetchOtpFromEmail,
    onEvent: async (event) => {
      try {
        await ctx.eventPipeline.process(event);
        await _updateFriendState(event);
        
        // 核心关注好友活动日志（从内存缓存读取，不查 DB）
        if (ctx.watchlist.dirty) refreshWatchlistCache();
        const isWatched = ctx.watchlist.cache.some(w => w.user_id === event.userId);
        if (isWatched) {
          log(`⭐ [关注] ${event.displayName || event.userId}: ${event.type}`);
        }
      } catch (err) {
        log(`⚠️ 事件处理失败: ${err.message}`);
      }
    },
    onStatusChange: (status) => {
      log(`🔌 WebSocket: ${status}`);
      if (status === 'connected') {
        // 连接后延迟对账：先让重连突发的实时推送（上线/下线）落地，再对账补漏，避免双记
        setTimeout(() => { _refreshOnlineState().catch(() => {}); }, 25_000);
        // WS 重连成功但启动登录可能失败(如 OTP 错位)，此处复查认证并同步 authUser
        ctx.api.checkAuth().then((res) => {
          if (res.valid) {
            ctx.serverState.authUser = { id: res.user.id, displayName: res.displayName };
          }
        }).catch((err) => {
          log(`⚠️ 认证复查失败: ${err.message}`);
        });
      }
    },
  });
  ctx.wsManager.start();

  // 7a. 数据库自动备份：启动时立即做一次 + 每 24h 一次（保留最近 2 份）
  const runAutoBackup = async () => {
    try {
      const r = await ctx.storage.backup(BACKUP_DIR);
      log(`💾 自动备份完成: ${r.path} (${r.size} bytes)`);
    } catch (e) {
      log(`⚠️ 自动备份失败: ${e.message}`);
    }
  };
  runAutoBackup();
  setInterval(runAutoBackup, BACKUP_INTERVAL_MS);

  // 7a. 好友头像补全：启动 90s 后首次 + 每 6 小时（低频，只补空头像）
  setTimeout(_syncFriendAvatars, 90 * 1000);
  setInterval(_syncFriendAvatars, 6 * 3600 * 1000);

  // 7a2. 追踪非好友（VRCX-Luo 对齐）：启动 20s 后自动导入历史非好友并首次拉取，之后每小时刷新
  setTimeout(async () => {
    await _seedTrackedNonFriends();
    await _refreshTrackedNonFriends();
  }, 20 * 1000);
  setInterval(_refreshTrackedNonFriends, 3600 * 1000);

  // 7b. 启动 MCP 服务
  const server = createServer();
  server.listen(PORT, HOST, () => {
    log(`\n🚀 MCP 服务运行在 http://${HOST}:${PORT}/mcp\n`);
    log('可用工具:');
    for (const t of registry.listTools()) {
      log(`  ${t.name} — ${t.description}`);
    }
    log(`\n健康检查: http://${HOST}:${PORT}/health`);
    log('\n按 Ctrl+C 停止\n');
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

// ── 优雅关闭 ──
async function shutdown(signal) {
  recordOpsLog('ops', 'info', `服务进程停止（${signal}——容器重建/手动停止）`);
  const { wsManager, eventPipeline, storage } = ctx;
  log(`\n⚠️ 收到 ${signal}，正在关闭...`);
  try {
    if (wsManager) wsManager.stop();
    if (eventPipeline) eventPipeline.flush();
    if (storage) storage.save();
    log('✅ 已保存数据');
  } catch (e) {
    console.error('关闭时出错:', e);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('beforeExit', () => {
  if (ctx.eventPipeline) ctx.eventPipeline.flush();
  if (ctx.storage) ctx.storage.save();
});

// ── 全局异常兜底（防止僵尸进程 + 端口残留）──
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
  shutdown('unhandledRejection');
});
