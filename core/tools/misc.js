/**
 * 杂项 handler — 系统状态 / 数据库统计 / 新世界扫描 / 关注名单 / 同屏 / 上线规律 / 昵称 / 备份
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ctx, log, invalidateWatchlistCache } from '../server-context.js';
import { isJunkWorld, worldScore, classifyWorlds, fetchFreshWorlds } from '../new-worlds.js';
import { backupDatabase } from '../backup.js';

export function handleGetDatabaseStats() {
  const { storage, friendState, eventPipeline } = ctx;
  return {
    ...storage.getStats(),
    friendState: friendState?.getStats(),
    eventPipeline: eventPipeline?.getStats(),
  };
}

/**
 * 确保 world_kb 某行的信息字段不为空（#76：兜底插入只写标记位，信息字段恒空）。
 * 优先从本地 world_cache 读 name/author_name；world_cache 也没有或需 created_at 时，
 * 串行调 API /worlds/{id}（限流）回填 world_cache 并取 created_at，再幂等回填 world_kb。
 * 幂等：world_kb 对应列已非空时不覆盖；world_cache 命中即省一次 API。
 * @param {{storage, api, rateLimiter}} c 上下文
 * @param {string} worldId
 * @returns {Promise<{worldId, worldName, authorName, authorId, createdAt}>}
 */
export async function ensureWorldKbInfo({ storage, api, rateLimiter }, worldId) {
  try {
    // 预检：读 world_kb 现有信息字段。created_at 已填 → 早退省 API；
    // 未填则即使 world_cache 命中 name/author，也须调一次 API 取 created_at（#77 阻断项修复）。
    const existing = storage.getWorldKbInfo(worldId);
    const info = {
      worldId,
      name: existing.worldName,
      authorName: existing.authorName,
      authorId: existing.authorId,
      createdAt: existing.createdAt,
    };
    const needApi = !info.createdAt;
    if (needApi && api && rateLimiter) {
      const cached = storage.getWorldName(worldId);
      if (cached && cached.name) {
        info.name = cached.name || '';
        info.authorName = cached.author_name || '';
        info.authorId = cached.author_id || '';
      }
      const r = await rateLimiter.execute(() => api._request('GET', `/worlds/${encodeURIComponent(worldId)}`));
      if (r.status === 200 && r.data && r.data.name) {
        info.name = info.name || r.data.name || '';
        info.authorName = info.authorName || r.data.authorName || '';
        info.authorId = info.authorId || r.data.authorId || '';
        info.createdAt = r.data.created_at || '';
        try { storage.upsertWorld({ worldId, name: info.name, authorId: info.authorId, authorName: info.authorName }); } catch (e) { /* 缓存写失败不阻断 */ }
      }
    } else if (!needApi && !info.name) {
      // created_at 已填但缺 name（罕见），补 world_cache / API
      const cached = storage.getWorldName(worldId);
      if (cached && cached.name) {
        info.name = cached.name || '';
        info.authorName = cached.author_name || '';
        info.authorId = cached.author_id || '';
      }
    }
    return storage.backfillWorldKbInfo({
      worldId,
      name: info.name, authorName: info.authorName, authorId: info.authorId, createdAt: info.createdAt,
    });
  } catch (e) {
    // 回填失败不阻断主操作（标记本身已成功）
    try { return storage.backfillWorldKbInfo({ worldId }); } catch (e2) { return { worldId, worldName: '', authorName: '', authorId: '', createdAt: '' }; }
  }
}

export function handleGetServerStatus() {
  const { storage, wsManager, friendState, eventPipeline, serverState } = ctx;
  return {
    status: 'running',
    startedAt: serverState.started,
    // needsTotp 状态（运行期 401 需 TOTP）时账号并未真正登录，需报 authenticated:false（issue #59）
    authenticated: !!serverState.authUser && !serverState.needsTotp,
    needsTotp: serverState.needsTotp,
    user: serverState.authUser,
    dbEvents: storage.getStats().events,
    dbFriends: storage.getStats().friends,
    ws: wsManager?.getState(),
    friendState: friendState?.getStats(),
    eventPipeline: eventPipeline?.getStats(),
  };
}

export async function handleScanNewWorlds({ days = 7, dryRun = false }) {
  const { storage, api, rateLimiter, serverState } = ctx;
  if (!days || days < 1 || days > 30) days = 7;
  const selfUserId = serverState.authUser?.id;
  if (!selfUserId) throw new Error('Not authenticated');

  const { fresh } = await fetchFreshWorlds(api, rateLimiter, { days, maxFetch: 200 });

  const visitedRows = storage._query(
    `SELECT DISTINCT world_id FROM events
     WHERE world_id IS NOT NULL AND world_id != ''
       AND (
         type = 'user-location'
         OR (type = 'friend-location' AND user_id = @selfUserId)
       )`,
    { $selfUserId: selfUserId }
  );
  const visited = new Set(visitedRows.map(r => r.world_id));

  const trackedRows = storage._query('SELECT world_id FROM world_kb');
  const tracked = new Set(trackedRows.map(r => r.world_id));

  const { unvisited, visitedFresh, toAdd, alreadyTracked } = classifyWorlds(fresh, visited, tracked);

  let written = 0;
  let updated = 0;
  const now = new Date().toISOString();

  if (!dryRun) {
    const upsert = storage.db.prepare(
      `INSERT INTO world_kb (world_id, world_name, author_name, author_id, created_at, first_seen_at, favorites, occupants, popularity, visited, visited_at, tags, description)
       VALUES (@world_id, @world_name, @author_name, @author_id, @created_at, @first_seen_at, @favorites, @occupants, @popularity, @visited, @visited_at, @tags, @description)
       ON CONFLICT(world_id) DO UPDATE SET
         world_name = excluded.world_name,
         author_id = excluded.author_id,
         favorites = excluded.favorites,
         occupants = excluded.occupants,
         popularity = excluded.popularity,
         visited = excluded.visited,
         visited_at = excluded.visited_at,
         tags = excluded.tags,
         description = excluded.description`
    );
    const markVisited = storage.db.prepare(
      `UPDATE world_kb SET visited = 1, visited_at = @visited_at
       WHERE world_id = @world_id AND visited = 0`
    );

    const tx = storage.db.transaction(() => {
      for (const w of toAdd) {
        upsert.run({
          world_id: w.id,
          world_name: w.name || '',
          author_name: w.authorName || '',
          author_id: w.authorId || '',
          created_at: w.created_at || null,
          first_seen_at: now,
          favorites: w.favorites || 0,
          occupants: w.occupants || 0,
          popularity: w.popularity || 0,
          visited: visited.has(w.id) ? 1 : 0,
          visited_at: visited.has(w.id) ? now : null,
          tags: Array.isArray(w.tags) ? JSON.stringify(w.tags) : '',
          description: w.description || '',
        });
        written++;
      }
      for (const w of fresh) {
        if (visited.has(w.id)) {
          const r = markVisited.run({ world_id: w.id, visited_at: now });
          if (r.changes > 0) updated++;
        }
      }
    });

    tx();
  }

  // 注入 DB 用户反馈（user_rating）到候选对象——否则 worldScore 加权对 API 对象恒为 0（Review 修复 #1）
  // unvisited 来自 API 拉取对象（无 userRating 字段），按 worldId 批量查 world_kb 的 user_rating
  const ratingParams = {};
  const ratingRows = unvisited.length > 0
    ? (() => {
        unvisited.forEach((w, i) => { ratingParams[`w${i}`] = w.id; });
        return storage._query(
          `SELECT world_id, user_rating FROM world_kb WHERE world_id IN (${unvisited.map((_, i) => `$w${i}`).join(',')})`,
          ratingParams
        );
      })()
    : [];
  const ratingMap = new Map(ratingRows.map(r => [r.world_id, r.user_rating || 0]));

  const recommended = [...unvisited]
    .map(w => ({ ...w, userRating: ratingMap.get(w.id) || 0 }))
    .sort((a, b) => worldScore(b) - worldScore(a))
    .slice(0, 10)
    .map(w => ({
      name: w.name,
      id: w.id,
      created: (w.created_at || '').slice(0, 10),
      favorites: w.favorites || 0,
      occupants: w.occupants || 0,
      popularity: w.popularity || 0,
      author: w.authorName,
      tags: (w.tags || []).filter(t => t.startsWith('author_tag_')).map(t => t.replace('author_tag_', '')),
      userRating: w.userRating,
    }));

  return {
    days,
    dryRun,
    collected: fresh.length,
    unvisited: unvisited.map(w => w.name),
    visited: visitedFresh.map(w => w.name),
    newlyTracked: toAdd.map(w => w.name),
    alreadyTracked: alreadyTracked.map(w => w.name),
    recommended,
  };
}

export function handleGetNewWorlds({ onlyUnvisited = false, limit = 10, sortBy = 'favorites', excludeTheme = '' }) {
  const { storage } = ctx;
  if (!['favorites', 'occupants', 'popularity', 'created_at'].includes(sortBy)) sortBy = 'favorites';
  limit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);

  // Issue #19 痛点 4：排除主题（按 author_tag_* 匹配，逗号分隔）。SQL 层排除（Review 修复 #3），
  // 避免 LIMIT 后 JS 过滤导致返回 < limit；total 也按排除语义统计。
  const excludedThemes = typeof excludeTheme === 'string' && excludeTheme.trim()
    ? excludeTheme.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];

  // 构造排除条件：tags 列是 JSON 数组字符串（["author_tag_game",...]），用 json_each 拆行匹配主题
  let where = '';
  const whereParams = {};
  if (onlyUnvisited) where += 'WHERE visited = 0 AND backlog = 0';
  if (excludedThemes.length > 0) {
    // 排除 = 不存在任何匹配主题的行（json_each 拆 JSON tags 数组匹配）
    // 兜底：json_valid(tags) 为假（空串/脏数据）时按 '[]' 处理，避免 malformed JSON 崩溃
    const notExists = excludedThemes.map((_, i) =>
      `NOT EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(world_kb.tags) THEN world_kb.tags ELSE '[]' END)
        WHERE lower(value) = $th${i}
      )`
    ).join(' AND ');
    where += (where ? ' AND ' : 'WHERE ') + notExists;
    excludedThemes.forEach((t, i) => { whereParams[`th${i}`] = `author_tag_${t}`; });
  }

  const total = storage._query(
    `SELECT COUNT(*) AS cnt FROM world_kb ${where}`,
    whereParams
  )[0].cnt;

  // 超额取数兜底：排除后可能不足 limit，取 3 倍候选再 JS 精过滤（tags 解析）
  const fetchLimit = Math.min(limit * 3, 100);
  const rows = storage._query(
    `SELECT world_id, world_name, author_name, created_at, first_seen_at, favorites, occupants, popularity, visited, visited_at, tags, user_rating
     FROM world_kb
     ${where}
     ORDER BY ${sortBy} DESC
     LIMIT ${fetchLimit}`,
    whereParams
  );

  const worlds = rows
    .map(r => {
      let worldTags = [];
      try { worldTags = JSON.parse(r.tags || '[]'); } catch (_) {}
      const themeTags = worldTags.filter(t => t.startsWith('author_tag_')).map(t => t.replace('author_tag_', '').toLowerCase());
      return {
        worldId: r.world_id,
        worldName: r.world_name,
        authorName: r.author_name,
        created: r.created_at,
        firstSeen: r.first_seen_at,
        favorites: r.favorites,
        occupants: r.occupants,
        popularity: r.popularity,
        visited: r.visited === 1,
        visitedAt: r.visited_at,
        tags: themeTags,
        userRating: r.user_rating || 0,
      };
    })
    .slice(0, limit);

  return { total, worlds };
}

/** 用户反馈：好图/烂图标记（Issue #19） */
export async function handleRateWorld({ worldId, rating = 0 }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  const r = parseInt(rating, 10);
  if (r !== -1 && r !== 0 && r !== 1) {
    throw new Error('rating must be -1 (junk), 0 (clear), or 1 (good)');
  }
  const result = storage.rateWorld({ worldId, rating: r });
  const info = await ensureWorldKbInfo(ctx, worldId);
  log(`⭐ 用户反馈: ${worldId} → rating=${result.userRating}${info.worldName ? ` (${info.worldName})` : ''}`);
  return { ...result, worldName: info.worldName };
}

/** 显式确认逛过某世界（Issue #19 痛点 3） */
export async function handleMarkWorldVisited({ worldId }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  const result = storage.markWorldVisited({ worldId });
  const info = await ensureWorldKbInfo(ctx, worldId);
  log(`✅ 手动标记 visited: ${worldId}${info.worldName ? ` (${info.worldName})` : ''}`);
  return { ...result, worldName: info.worldName };
}

/** 手动标记某世界为适合睡觉的地图（recommend 用 sleep_ok 强信号） */
export async function handleSetWorldSleep({ worldId, isSleep = true }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  const result = storage.setWorldSleep({ worldId, isSleep: !!isSleep });
  const info = await ensureWorldKbInfo(ctx, worldId);
  log(`${result.isSleep ? '🛏' : '✖️'} 标记睡觉图: ${worldId}${info.worldName ? ` (${info.worldName})` : ''} → sleep_ok=${result.isSleep ? 1 : 0}`);
  return { ...result, worldName: info.worldName };
}

/** 待逛列表：加入/更新（幂等） */
export async function handleAddToBacklog({ worldId, reason = '', priority = 0 }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  const result = storage.addToBacklog({ worldId, reason, priority });
  const info = await ensureWorldKbInfo(ctx, worldId);
  log(`📌 加入待逛: ${worldId}${info.worldName ? ` (${info.worldName})` : ''} priority=${result.priority}`);
  return { ...result, worldName: info.worldName };
}

/** 待逛列表：查询 */
export function handleGetBacklog({ status = 'pending', sortBy = 'added_at', limit = 20 } = {}) {
  return ctx.storage.getBacklog({ status, sortBy, limit });
}

/** 待逛列表：移除 */
export function handleRemoveFromBacklog({ worldId }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  const result = storage.removeFromBacklog({ worldId });
  log(`🗑 移出待逛: ${worldId}`);
  return result;
}

export function handleGetWatchlist() {
  return { watchlist: ctx.storage.getWatchlist() };
}

export function handleAddToWatchlist({ userId, displayName, priority = 1 }) {
  const { storage } = ctx;
  storage.addToWatchlist(userId, displayName, priority);
  storage.save();
  invalidateWatchlistCache();
  return { success: true, userId, priority };
}

export function handleRemoveFromWatchlist({ userId }) {
  const { storage } = ctx;
  storage.removeFromWatchlist(userId);
  storage.save();
  invalidateWatchlistCache();
  return { success: true, userId };
}

export function handleGetCompanions({ startTime, endTime, userId, includeTimeline }) {
  const { storage, serverState } = ctx;
  const targetUserId = userId || serverState.authUser?.id;
  if (!targetUserId) throw new Error('No userId provided and not authenticated');
  return storage.findCompanions(targetUserId, startTime, endTime, includeTimeline === true);
}

export function handleGetOnlinePattern({ userId, days, startTime, endTime }) {
  const { storage } = ctx;
  if (!userId) throw new Error('userId is required');
  const opts = {};
  if (startTime && endTime) {
    opts.startTime = startTime;
    opts.endTime = endTime;
  } else if (days !== undefined && days !== null) {
    opts.days = days;
  }
  return storage.getOnlinePattern(userId, opts);
}

export function handleGetNicknames({ userId, query }) {
  return { nicknames: ctx.storage.getNicknames({ userId, query }) };
}

export function handleSetNickname({ userId, nickname, displayName }) {
  const { storage } = ctx;
  if (!userId) throw new Error('userId is required');
  if (!nickname) throw new Error('nickname is required');
  const result = storage.setNickname({ userId, nickname, displayName });
  storage.save();
  return result;
}

export async function handleBackupDatabase() {
  try {
    const result = await backupDatabase(ctx.storage.db, ctx.paths.BACKUP_DIR);
    log(`💾 手动备份完成: ${result.path} (${result.size} bytes)`);
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ── MCP 自声明工具表 ──
export const tools = [
  {
    "name": "get_database_stats",
    "description": "[system] Get local database statistics (event count, friend count, etc).",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    handler: async (args) => handleGetDatabaseStats(args)
  },
  {
    "name": "get_server_status",
    "description": "[system] Check server health and auth status.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    handler: async (args) => handleGetServerStatus(args)
  },
  {
    "name": "scan_new_worlds",
    "description": "[action] Scan VRChat for worlds created in the last N days, filter junk, write to the world_kb table, and return a recommended list. dryRun=true only reports without writing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "days": {
          "type": "number",
          "default": 7,
          "description": "Lookback window in days (1-30, default 7)"
        },
        "dryRun": {
          "type": "boolean",
          "default": false,
          "description": "Report only, do not write to DB"
        }
      }
    },
    handler: async (args) => handleScanNewWorlds(args)
  },
  {
    "name": "get_new_worlds",
    "description": "[query] Query tracked new worlds from the world_kb table (read-only). Filter by visited, sort by heat, limit count.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "onlyUnvisited": {
          "type": "boolean",
          "default": false,
          "description": "Only return worlds the user has not visited"
        },
        "limit": {
          "type": "number",
          "default": 10,
          "description": "Max rows (1-50, default 10)"
        },
        "sortBy": {
          "type": "string",
          "enum": [
            "favorites",
            "occupants",
            "popularity",
            "created_at"
          ],
          "default": "favorites",
          "description": "Sort field (descending)"
        },
        "excludeTheme": {
          "type": "string",
          "description": "Comma-separated theme keywords to exclude (matched against author tags, e.g. \"game,horror,dance\")"
        }
      }
    },
    handler: async (args) => handleGetNewWorlds(args)
  },
  {
    "name": "rate_world",
    "description": "[action] Rate a world as good/junk for recommendation feedback (Issue #19). rating=1 good (weighted up), -1 junk (weighted down/excluded), 0 clear.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "VRChat world ID (wrld_...)"
        },
        "rating": {
          "type": "number",
          "enum": [
            -1,
            0,
            1
          ],
          "description": "-1=junk, 0=clear, 1=good"
        }
      },
      "required": [
        "worldId",
        "rating"
      ]
    },
    handler: async (args) => handleRateWorld(args)
  },
  {
    "name": "mark_world_visited",
    "description": "[action] Explicitly mark a world as visited (Issue #19: event-driven visited can miss). Useful to close the recommend-open-browse loop.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "VRChat world ID (wrld_...)"
        }
      },
      "required": [
        "worldId"
      ]
    },
    handler: async (args) => handleMarkWorldVisited(args)
  },
  {
    "name": "set_world_sleep",
    "description": "[action] Manually mark a world as a sleep-friendly map (sets sleep_ok=1, a strong signal in recommend_join/recommend_worlds). isSleep=false clears the marker. Local-only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "VRChat world ID (wrld_...)"
        },
        "isSleep": {
          "type": "boolean",
          "default": true,
          "description": "true=mark as sleep map, false=clear"
        }
      },
      "required": [
        "worldId"
      ]
    },
    handler: async (args) => handleSetWorldSleep(args)
  },
  {
    "name": "add_to_backlog",
    "description": "[action] Add a world to your local to-visit backlog (待逛列表). Worlds stay pending until visited (auto-cleared by location events) or manually removed. Idempotent: re-adding updates reason/priority. Local-only, does not touch VRChat cloud favorites.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "VRChat world ID (wrld_...)"
        },
        "reason": {
          "type": "string",
          "description": "Why you want to visit (e.g. 氛围图/解谜/温泉/带人逛)"
        },
        "priority": {
          "type": "number",
          "enum": [
            0,
            1,
            2
          ],
          "default": 0,
          "description": "0=normal, 1=high, 2=must visit"
        }
      },
      "required": [
        "worldId"
      ]
    },
    handler: async (args) => handleAddToBacklog(args)
  },
  {
    "name": "get_backlog",
    "description": "[query] List worlds in your local to-visit backlog (待逛列表). status=pending (default) shows unvisited to-visit worlds; visited shows the ones already visited (they leave the pending view automatically once visited); all shows both. Each item carries snapshot details (favorites/tags/description) from the local world knowledge table.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "pending",
            "visited",
            "all"
          ],
          "default": "pending",
          "description": "pending=未逛, visited=逛完历史, all=全部"
        },
        "sortBy": {
          "type": "string",
          "enum": [
            "added_at",
            "priority",
            "favorites"
          ],
          "default": "added_at",
          "description": "Sort field (descending)"
        },
        "limit": {
          "type": "number",
          "default": 20,
          "description": "Max rows (1-50, default 20)"
        }
      }
    },
    handler: async (args) => handleGetBacklog(args)
  },
  {
    "name": "remove_from_backlog",
    "description": "[action] Remove a world from the to-visit backlog (待逛列表). Local-only, does not affect cloud favorites. Idempotent.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "VRChat world ID (wrld_...)"
        }
      },
      "required": [
        "worldId"
      ]
    },
    handler: async (args) => handleRemoveFromBacklog(args)
  },
  {
    "name": "get_watchlist",
    "description": "[manage] List all watched friends.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    handler: async (args) => handleGetWatchlist(args)
  },
  {
    "name": "add_to_watchlist",
    "description": "[manage] Add a friend to watchlist.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "userId": {
          "type": "string",
          "description": "VRChat user ID (usr_...)"
        },
        "displayName": {
          "type": "string",
          "description": "Optional display name"
        },
        "priority": {
          "type": "number",
          "default": 1,
          "description": "Priority 0-5"
        }
      },
      "required": [
        "userId"
      ]
    },
    handler: async (args) => handleAddToWatchlist(args)
  },
  {
    "name": "remove_from_watchlist",
    "description": "[manage] Remove a friend from watchlist.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "userId": {
          "type": "string",
          "description": "VRChat user ID (usr_...)"
        }
      },
      "required": [
        "userId"
      ]
    },
    handler: async (args) => handleRemoveFromWatchlist(args)
  },
  {
    "name": "get_companions",
    "description": "[query] Find all friends who were in the same instances as you during a time range. Uses SQLite cross-reference by instanceId. Each companion has: userId/displayName/firstSeen/lastSeen/matchCount/worlds (worlds is a STRING array of world names or worldIds, NOT objects). By default userTimeline is omitted (empty array) to avoid huge MCP output when the range spans many location events; pass includeTimeline=true to include the full per-event location timeline.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "startTime": {
          "type": "string",
          "description": "Start time (ISO 8601, UTC recommended, e.g. 2026-07-25T11:00:00Z)"
        },
        "endTime": {
          "type": "string",
          "description": "End time (ISO 8601, UTC)"
        },
        "userId": {
          "type": "string",
          "description": "Optional: override userId. Defaults to current user."
        },
        "includeTimeline": {
          "type": "boolean",
          "description": "Optional: include the full user location timeline (default false to avoid oversized output)."
        }
      },
      "required": [
        "startTime",
        "endTime"
      ]
    },
    handler: async (args) => handleGetCompanions(args)
  },
  {
    "name": "get_online_pattern",
    "description": "[query] Analyze a friend's online activity pattern (hourly distribution and frequency in Beijing time).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "userId": {
          "type": "string",
          "description": "VRChat user id (usr_...)"
        },
        "days": {
          "type": "number",
          "default": 30,
          "description": "Analyze last N days (Beijing time natural days, default 30)"
        },
        "startTime": {
          "type": "string",
          "description": "Optional exact start time (ISO 8601 UTC); if provided with endTime, overrides days"
        },
        "endTime": {
          "type": "string",
          "description": "Optional exact end time (ISO 8601 UTC); if provided with startTime, overrides days"
        }
      },
      "required": [
        "userId"
      ]
    },
    handler: async (args) => handleGetOnlinePattern(args)
  },
  {
    "name": "get_nicknames",
    "description": "[manage] Query friend nickname mappings (exact by userId, fuzzy by nickname/displayName, or all).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "userId": {
          "type": "string",
          "description": "VRChat user id (usr_...)"
        },
        "query": {
          "type": "string",
          "description": "Fuzzy search on display_name or nickname"
        }
      }
    },
    handler: async (args) => handleGetNicknames(args)
  },
  {
    "name": "set_nickname",
    "description": "[manage] Set or update a friend nickname mapping (upsert).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "userId": {
          "type": "string",
          "description": "VRChat user id (usr_...)"
        },
        "nickname": {
          "type": "string",
          "description": "Nickname to store"
        },
        "displayName": {
          "type": "string",
          "description": "Optional current display name"
        }
      },
      "required": [
        "userId",
        "nickname"
      ]
    },
    handler: async (args) => handleSetNickname(args)
  },
  {
    "name": "backup_database",
    "description": "[system] Immediately back up the local database (WAL online backup, no restart needed). Keeps the 2 most recent backups in backups/.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    handler: async (args) => handleBackupDatabase(args)
  }
];
