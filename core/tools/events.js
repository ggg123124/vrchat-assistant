/**
 * 事件历史 handler — 事件查询 / 世界名 / 世界备注 / 世界历史 / 周报
 */

import { ctx, log } from '../server-context.js';
import { resolveWorldNames } from '../world-names.js';

export async function handleGetFriendEvents({ userId, limit = 20, offset = 0, types }) {
  const { storage } = ctx;
  // 单类型查询
  if (types && !types.includes(',')) {
    const events = storage.getEventsByUser(userId, { limit, offset, type: types.trim() });
    return { userId, total: events.length, events };
  }
  // 多类型/无类型过滤
  const events = storage.getEventsByUser(userId, { limit, offset });
  if (types) {
    const typeSet = new Set(types.split(',').map(t => t.trim()));
    const filtered = events.filter(e => typeSet.has(e.type));
    return { userId, total: filtered.length, events: filtered };
  }
  return { userId, total: events.length, events };
}

export function handleGetFriendPairMeetings({ userIdA, userIdB, startTime, endTime, days, windowMinutes }) {
  const { storage } = ctx;
  if (!userIdA || !userIdB) throw new Error('userIdA and userIdB are required');
  if (userIdA === userIdB) throw new Error('userIdA and userIdB must be different');
  let start, end;
  if (startTime && endTime) {
    start = startTime;
    end = endTime;
  } else {
    const d = days || 30;
    end = new Date().toISOString();
    start = new Date(Date.now() - d * 86400000).toISOString();
  }
  return storage.findFriendPairMeetings(userIdA, userIdB, start, end, windowMinutes);
}

export function handleGetFriendPairScreen({ userIdA, userIdB, startTime, endTime, days, windowMinutes, limit }) {
  const { storage } = ctx;
  if (!userIdA || !userIdB) throw new Error('userIdA and userIdB are required');
  if (userIdA === userIdB) throw new Error('userIdA and userIdB must be different');
  let start, end;
  if (startTime && endTime) {
    start = startTime;
    end = endTime;
  } else {
    const d = days || 30;
    end = new Date().toISOString();
    start = new Date(Date.now() - d * 86400000).toISOString();
  }
  return storage.findFriendPairScreen(userIdA, userIdB, start, end, windowMinutes, limit);
}

/**
 * 最近一起玩：与自己同屏（同实例共玩）过的好友列表，按同屏次数降序。
 * 复用周报的同屏合并引擎（getWeeklyCompanions：北京自然日逐日 findCompanions 匹配），
 * 输出精简为列表（matchCount/daysCount/lastDay），供 dashboard 右侧栏与 MCP Agent 消费。
 */
export function handleGetRecentCooplay({ days = 7, limit = 30 } = {}) {
  const { storage, serverState } = ctx;
  const meId = serverState.authUser?.id;
  if (!meId) throw new Error('Not authenticated');
  const d = Math.min(Math.max(Number.parseInt(days, 10) || 7, 1), 90);
  const lim = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100);
  const endIso = new Date().toISOString();
  const startIso = new Date(Date.now() - d * 86400000).toISOString();
  const merged = storage.getWeeklyCompanions(meId, startIso, endIso);
  const list = [];
  for (const [userId, m] of merged) {
    const dayLabels = [...(m.days || [])].sort();
    list.push({
      userId,
      displayName: m.displayName || '',
      matchCount: m.matchCount || 0,
      daysCount: dayLabels.length,
      lastDay: dayLabels.length ? dayLabels[dayLabels.length - 1] : '',
    });
  }
  list.sort((a, b) => b.matchCount - a.matchCount);
  return { days: d, total: list.length, companions: list.slice(0, lim) };
}

export function handleGetOpsLog({ limit = 200, kind } = {}) {
  const { storage } = ctx;
  const cap = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 1000);
  const rows = storage.getOpsLog({ limit: cap, kind });
  return {
    items: rows.map(r => ({
      id: r.id,
      kind: r.kind,
      level: r.level,
      message: r.message,
      createdAt: r.created_at,
    })),
  };
}

export function handleGetRecentEvents({ limit = 30, offset = 0, typeFilter, userIdFilter }) {
  const { storage } = ctx;
  const types = typeFilter ? String(typeFilter).split(',').map(t => t.trim()).filter(Boolean) : [];
  if (types.length > 0) {
    // SQL 层类型过滤（2026-09-06 修复）：原实现先取最近 limit+offset 条再内存过滤，
    // 低频类型（friend-delete 等）被高频事件挤出滚动窗口后永远查不到历史；
    // 改走 WHERE type IN(...) 全史检索，typeFilter 语义 =「该类型最近 N 条」而非「全局窗口内命中」。
    const events = storage.getEventsFiltered({
      types,
      userId: userIdFilter || '',
      limit,
      offset,
    });
    return { total: events.length, events };
  }
  // 无类型过滤：保持原「最新事件流」语义
  let events;
  if (userIdFilter) {
    events = storage.getEventsByUser(userIdFilter, { limit: limit + offset });
    if (offset > 0) events = events.slice(offset);
  } else {
    events = storage.getRecentEvents({ limit: limit + offset });
    if (offset > 0) events = events.slice(offset);
  }
  return { total: events.length, events };
}

export async function handleGetWorldName({ worldId, forceRefresh }) {
  const { storage, api } = ctx;
  // 懒刷新：缓存命中直接返回，只有 forceRefresh 或缓存不存在时才走 API
  if (!forceRefresh) {
    const cached = storage.getWorldName(worldId);
    if (cached) {
      return { worldId, name: cached.name, source: 'cache', ...cached };
    }
  }
  // 调 API
  const prev = storage.getWorldName(worldId);
  const r = await api._request('GET', `/worlds/${worldId}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const w = r.data;
  const result = {
    worldId: w.id,
    name: w.name,
    authorId: w.authorId,
    authorName: w.authorName,
    capacity: w.capacity,
    occupants: w.occupants,
    releaseStatus: w.releaseStatus,
    tags: w.tags,
    description: (w.description || '').slice(0, 200),
    imageUrl: w.imageUrl,
    favorites: w.favorites,
    note: prev?.note ?? null,
    source: 'api',
  };
  // 写入缓存（不覆盖 note）
  storage.upsertWorld({
    worldId: w.id, name: w.name, authorId: w.authorId, authorName: w.authorName,
    capacity: w.capacity, favorites: w.favorites,
    releaseStatus: w.releaseStatus, tags: w.tags || [],
    description: w.description || '', imageUrl: w.imageUrl || '',
  });
  return result;
}

/**
 * 通过作者 ID / 作者名列出该作者发布的全部世界。
 * authorName 给定 → GET /users?search 精确匹配解析 userId；
 * 然后用 GET /worlds?userId=<authorId>&n=100&offset=... 分页拉全。
 */
export async function handleGetWorldsByAuthor({ authorId, authorName, limit = 100 }) {
  const { storage, api, rateLimiter } = ctx;
  const cap = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  if (!authorId && !authorName) throw new Error('authorId or authorName is required');
  if (authorId && authorName) throw new Error('authorId and authorName are mutually exclusive');

  let resolvedAuthorId = authorId;
  let resolvedAuthorName = authorName || '';
  if (authorName) {
    const target = authorName.trim();
    const ur = await rateLimiter.execute(() => api._request('GET', `/users?search=${encodeURIComponent(target)}&n=10`));
    if (ur.status !== 200 || !Array.isArray(ur.data) || ur.data.length === 0) {
      throw new Error(`作者未找到: ${target}`);
    }
    const norm = s => (s || '').toLowerCase().replace(/\s+/g, '');
    const user = ur.data.find(u => norm(u.displayName) === norm(target));
    if (!user?.id) throw new Error(`作者未找到(精确匹配): ${target}`);
    resolvedAuthorId = user.id;
    resolvedAuthorName = user.displayName || authorName;
  }

  const worlds = [];
  let offset = 0;
  while (worlds.length < cap) {
    const n = Math.min(100, cap - worlds.length);
    const r = await rateLimiter.execute(() => api._request('GET', `/worlds?userId=${encodeURIComponent(resolvedAuthorId)}&n=${n}&offset=${offset}`));
    if (r.status !== 200 || !Array.isArray(r.data)) break;
    if (r.data.length === 0) break;
    for (const w of r.data) {
      worlds.push({
        worldId: w.id,
        name: w.name,
        authorId: w.authorId,
        authorName: w.authorName,
        description: (w.description || '').slice(0, 200),
        imageUrl: w.imageUrl,
        favorites: w.favorites || 0,
        visits: w.visits || 0,
        capacity: w.capacity || 0,
        releaseStatus: w.releaseStatus,
        tags: Array.isArray(w.tags) ? w.tags : [],
        publishedAt: w.publicationDate || w.createdAt || null,
      });
      // 顺带写缓存（带 authorId，方便后续推荐/查询）
      try {
        storage.upsertWorld({
          worldId: w.id, name: w.name, authorId: w.authorId, authorName: w.authorName,
          capacity: w.capacity, favorites: w.favorites, releaseStatus: w.releaseStatus,
          tags: Array.isArray(w.tags) ? w.tags : [], description: w.description || '', imageUrl: w.imageUrl || '',
        });
      } catch (_) {}
      if (worlds.length >= cap) break;
    }
    if (r.data.length < n) break;
    offset += r.data.length;
  }

  log(`[查询] get_worlds_by_author: ${resolvedAuthorName} (${resolvedAuthorId}) → ${worlds.length} 张图`);
  return { authorId: resolvedAuthorId, authorName: resolvedAuthorName, total: worlds.length, worlds };
}

export function handleSetWorldNote({ worldId, note }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  if (note === undefined || note === null) throw new Error('note is required (empty string clears)');
  const result = storage.setWorldNote({ worldId, note });
  storage.save();
  return result;
}

export function handleGetWorldHistory({ worldId, limit = 50 }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  return { worldId, history: storage.getWorldHistory(worldId, limit) };
}

// 好友资料变更历史（2026-08-19 新增，配合事件管道 friend-profile 变更追踪）。
// 查询 events 表中 content_json.type ∈ {avatar,status,bio,user_icon,pronouns} 的记录。
// userId 可选（省略 = 全部好友），types 逗号分隔过滤，limit/offset 分页。
export function handleGetFriendProfileChanges({ userId, limit = 50, offset = 0, types }) {
  const { storage } = ctx;
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = storage.getFriendProfileChanges(userId || '', { limit: cap, offset: off, types });
  const total = storage.getFriendProfileChangeCount(userId || '', { types });
  const changes = rows.map(r => {
    let c = {};
    try { c = JSON.parse(r.content_json); } catch {}
    const payload = { ...c };
    delete payload.userId; delete payload.displayName; delete payload.type; delete payload.vrcxId;
    return {
      userId: r.user_id,
      displayName: r.display_name,
      changeType: c.type,
      source: r.source,
      createdAt: r.created_at,
      change: payload,
    };
  });
  return {
    userId: userId || null,
    types: types ? String(types).split(',').map(t => t.trim()) : null,
    total,
    limit: cap,
    offset: off,
    changes,
  };
}

export async function handleGetWeeklyReport({ days = 7 }) {
  const { storage, api, serverState } = ctx;
  if (!days || days < 1 || days > 90) days = 7;
  // 北京时间窗口（UTC - 8h）
  const endUtc = new Date(Date.now() - 8 * 3600 * 1000);  // 北京当前时刻转 UTC
  const startMs = endUtc.getTime() - days * 86400000;
  const startUtc = new Date(startMs);
  const startIso = startUtc.toISOString();
  const endIso = endUtc.toISOString();

  const userId = serverState.authUser?.id;
  if (!userId) throw new Error('Not authenticated');

  // 1. 会话切分 → 世界停留统计
  const sessions = storage.getOwnWorldSessions(startIso, endIso);
  const worldMinutes = new Map();  // worldId -> {minutes, visits}
  const dayWorlds = new Map();     // MM-DD -> Set<worldId>
  for (const s of sessions) {
    if (!worldMinutes.has(s.worldId)) worldMinutes.set(s.worldId, { minutes: 0, visits: 0 });
    const w = worldMinutes.get(s.worldId); w.minutes += s.minutes; w.visits++;
    const dayLabel = new Date(Date.parse(s.start) + 8 * 3600 * 1000).toISOString().slice(5, 10);
    if (!dayWorlds.has(dayLabel)) dayWorlds.set(dayLabel, new Set());
    dayWorlds.get(dayLabel).add(s.worldId);
  }

  // 2. 同屏合并
  const companions = storage.getWeeklyCompanions(userId, startIso, endIso);

  // 3. 自己的上线规律（复用 getOnlinePattern，window = 30 天）
  const pattern = storage.getOnlinePattern(userId, { days: Math.max(days, 30) });

  // 4. 世界名解析（缓存优先，缺失批量 API 查询并写 world_cache——懒刷新，无 TTL 自动过期；
  //    统一走 resolveWorldNames，失败写进程内负缓存避免重复重试）
  const allWorldIds = new Set([...worldMinutes.keys(), ...(function(){ const s=new Set(); for (const d of dayWorlds.values()) for (const w of d) s.add(w); return s; })()]);
  const nameMap = await resolveWorldNames(ctx, [...allWorldIds], { throttleMs: 0, onFail: (wid) => wid });
  const worldNameMap = Object.fromEntries([...nameMap.entries()]);

  // 5. 群组活动（自己进过的群组房）——从 sessions 对应的事件里找 ~group(grp_/gmem_xxx)
  //    直接查 user-location 事件的 groupId
  const myGroupRows = storage.query(
    `SELECT content_json, created_at FROM events WHERE type='user-location' AND created_at >= $s AND created_at <= $e
     AND (content_json LIKE '%~group(grp_%' OR content_json LIKE '%~group(gmem_%') ORDER BY created_at`,
    { $s: startIso, $e: endIso }
  );
  const groupActivities = [];
  const groupIds = new Set();
  for (const row of myGroupRows) {
    try {
      const c = JSON.parse(row.content_json);
      const loc = c.location || '';
      // VRChat 群组 ID 已从 grp_ 迁移为 gmem_ (2026-08 实测), 两种前缀都匹配
      const m = loc.match(/~group\((grp_[a-f0-9-]+|gmem_[a-f0-9-]+)\)/);
      if (m) {
        groupIds.add(m[1]);
        const wid = loc.split(':')[0];
        groupActivities.push({ time: row.created_at, worldId: wid, worldName: worldNameMap[wid] || wid, groupId: m[1] });
      }
    } catch {}
  }
  // 补充解析群组房的世界名（第 4 步未覆盖的；resolveWorldNames 内部有负缓存，不会重复 API）
  const groupWids = [...new Set(groupActivities.map(a => a.worldId).filter(w => w && !worldNameMap[w]))];
  if (groupWids.length > 0) {
    const gNameMap = await resolveWorldNames(ctx, groupWids, { throttleMs: 0, onFail: (wid) => wid });
    for (const [wid, name] of gNameMap.entries()) worldNameMap[wid] = name;
  }
  // 回填 groupActivities 的世界名
  for (const a of groupActivities) {
    if (worldNameMap[a.worldId]) a.worldName = worldNameMap[a.worldId];
  }

  // 6. 圈内活动日历（好友群组房统计）
  const friendGroups = storage.getFriendGroupStats(startIso, endIso);
  for (const gid of friendGroups.keys()) groupIds.add(gid);

  // 7. 群组信息（group_cache 优先，缺失查 API 并缓存；TTL 7 天）
  const groupInfoMap = {};
  const missingGroups = [];
  for (const gid of groupIds) {
    const cached = storage.getGroupCached(gid);
    if (cached && cached.name && (Date.now() - Date.parse(cached.updated_at.replace(' ', 'T') + 'Z')) < 7 * 86400000) {
      groupInfoMap[gid] = { groupId: gid, name: cached.name, description: cached.description, memberCount: cached.member_count };
    } else missingGroups.push(gid);
  }
  let groupCacheUpdated = false;
  for (const gid of missingGroups) {
    try {
      const r = await api._request('GET', `/groups/${gid}`);
      if (r.status === 200 && r.data) {
        const d = r.data;
        groupInfoMap[gid] = { groupId: gid, name: d.name || gid, description: d.description || '', memberCount: d.memberCount || 0 };
        storage.upsertGroupCache({ groupId: gid, name: d.name || '', description: d.description || '', memberCount: d.memberCount || 0 });
        groupCacheUpdated = true;
      } else groupInfoMap[gid] = { groupId: gid, name: gid, description: '', memberCount: 0 };
    } catch { groupInfoMap[gid] = { groupId: gid, name: gid, description: '', memberCount: 0 }; }
  }
  if (groupCacheUpdated) storage.save();

  // 8. 昵称映射（带昵称展示）
  const nicknames = storage.getNicknames({});
  const nickMap = {};
  for (const n of nicknames) nickMap[n.userId] = n.nickname || n.displayName;

  // 组装结果
  const topWorlds = [...worldMinutes.entries()]
    .map(([wid, v]) => ({ worldId: wid, name: worldNameMap[wid] || wid, minutes: Math.round(v.minutes), visits: v.visits }))
    .sort((a, b) => b.minutes - a.minutes);

  const topCompanions = [...companions.entries()]
    .map(([uid, v]) => ({ userId: uid, displayName: v.displayName, nickname: nickMap[uid] || null, matchCount: v.matchCount, days: v.days.size, dayList: [...v.days].sort() }))
    .sort((a, b) => b.days - a.days || b.matchCount - a.matchCount);

  const friendGroupCalendar = [...friendGroups.entries()]
    .map(([gid, v]) => ({ groupId: gid, groupName: groupInfoMap[gid]?.name || gid, friendCount: v.users.size, eventCount: v.count, worldCount: v.worlds.size, memberCount: groupInfoMap[gid]?.memberCount || 0 }))
    .sort((a, b) => b.friendCount - a.friendCount || b.eventCount - a.eventCount);

  return {
    period: { start: startIso, end: endIso, days, tz: 'UTC' },
    overview: {
      activeDays: dayWorlds.size,
      totalMinutes: Math.round(sessions.reduce((a, s) => a + s.minutes, 0)),
      worldsVisited: worldMinutes.size,
      companionUsers: companions.size,
      topCompanion: topCompanions[0] ? { userId: topCompanions[0].userId, displayName: topCompanions[0].displayName, nickname: topCompanions[0].nickname, days: topCompanions[0].days, matchCount: topCompanions[0].matchCount } : null,
    },
    daily: [...dayWorlds.entries()].sort().map(([day, worlds]) => ({
      day,
      worlds: [...worlds].map(w => ({ worldId: w, name: worldNameMap[w] || w })),
      // 每日同屏伙伴（昵称 + 当天次数），次数降序
      companions: [...companions.entries()]
        .filter(([uid, v]) => v.days.has(day))
        .map(([uid, v]) => ({ userId: uid, displayName: v.displayName, nickname: nickMap[uid] || null, matchCount: v.dayCounts[day] || 0 }))
        .sort((a, b) => b.matchCount - a.matchCount),
    })),
    topWorlds,
    ownPattern: {
      activeDays30: pattern.activeDates?.length || 0,
      hourly: pattern.hourly?.location || {},
      peakHour: pattern.peak?.activePeakHour ?? null,
      avgGapDays: pattern.frequency?.avgGapDays ?? null,
      longestGapDays: pattern.frequency?.longestGapDays ?? null,
    },
    topCompanions,
    groupActivities: groupActivities.map(a => ({ ...a, groupName: groupInfoMap[a.groupId]?.name || a.groupId, memberCount: groupInfoMap[a.groupId]?.memberCount || 0 })),
    friendGroupCalendar,
  };
}

// ── MCP 自声明工具表 ──
export const tools = [
  {
    "name": "get_friend_events",
    "description": "[query] Query a friend's event history from local database.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "userId": {
          "type": "string",
          "description": "Friend ID (usr_...)"
        },
        "limit": {
          "type": "number",
          "default": 20
        },
        "offset": {
          "type": "number",
          "default": 0
        },
        "types": {
          "type": "string",
          "description": "Comma-separated event types to filter"
        }
      },
      "required": [
        "userId"
      ]
    },
    handler: async (args) => handleGetFriendEvents(args)
  },
  {
    "name": "get_recent_events",
    "description": "[query] 事件流查询：无 typeFilter 时返回最新事件（最近滚动窗口）；带 typeFilter 时为 SQL 层按类型检索——返回该类型最近的事件（可查任意历史，非仅当前窗口），如 typeFilter='friend-delete' 可查被删除好友记录。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "number",
          "default": 30
        },
        "offset": {
          "type": "number",
          "default": 0
        },
        "typeFilter": {
          "type": "string",
          "description": "Comma-separated event types to filter (SQL-level history search)"
        },
        "userIdFilter": {
          "type": "string",
          "description": "Filter by friend user ID"
        }
      }
    },
    handler: async (args) => handleGetRecentEvents(args)
  },
  {
    "name": "get_friend_pair_meeting",
    "description": "[query] 查询两个好友（任意第三方）之间「每次见面」的时段与时长（单次见面分析）。按实例切分：同一实例内所有同屏匹配事件合并为一次见面，返回每次的 start/end/durationMinutes、世界与实例；同时给出 meetingCount（见面次数）与 totalDurationSeconds（总时长）。精确口径：B 的每条可识别实例事件匹配 A 同一实例且时间差 ≤ windowMinutes → 计同屏；排除 offline/traveling/private（private 无房主信息无法判定同房）。startTime/endTime 与 days 二选一，windowMinutes 默认 30。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "userIdA": {
          "type": "string",
          "description": "好友 A 的 userId（usr_...），必填"
        },
        "userIdB": {
          "type": "string",
          "description": "好友 B 的 userId（usr_...），必填"
        },
        "startTime": {
          "type": "string",
          "description": "起始时间（ISO 8601 UTC），与 endTime 成对"
        },
        "endTime": {
          "type": "string",
          "description": "结束时间（ISO 8601 UTC），与 startTime 成对"
        },
        "days": {
          "type": "number",
          "description": "回溯天数（默认 30），未给 startTime/endTime 时生效"
        },
        "windowMinutes": {
          "type": "number",
          "description": "同屏判定时间窗口（分钟，默认 30）"
        }
      },
      "required": [
        "userIdA",
        "userIdB"
      ]
    },
    handler: async (args) => handleGetFriendPairMeetings(args)
  },
  {
    "name": "get_friend_pair_screen",
    "description": "[query] 查询两个好友（任意第三方）之间的同屏次数与时长（共玩/同房分析）。精确口径：对好友 B 的每条可识别实例事件，找好友 A 在同一实例且时间戳在 ±windowMinutes 内的匹配，计为一次同屏；排除 offline/traveling/private（private 无房主信息无法判定同房）。不同时间去过同一房间不计。返回 matchCount（次数）、totalMinutes/totalSeconds（总同屏时长，段首到段尾累加，含实例内中途断开空档）、worldDuration（按世界拆分时长）、worlds（共现世界）与 matches（匹配事件对，默认全量，可用 limit 限制条数——采样密集时 matches 可能上千条）。startTime/endTime 与 days 二选一，windowMinutes 默认 30。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "userIdA": {
          "type": "string",
          "description": "好友 A 的 userId（usr_...），必填"
        },
        "userIdB": {
          "type": "string",
          "description": "好友 B 的 userId（usr_...），必填"
        },
        "startTime": {
          "type": "string",
          "description": "起始时间（ISO 8601 UTC），与 endTime 成对"
        },
        "endTime": {
          "type": "string",
          "description": "结束时间（ISO 8601 UTC），与 startTime 成对"
        },
        "days": {
          "type": "number",
          "description": "回溯天数（默认 30），未给 startTime/endTime 时生效"
        },
        "windowMinutes": {
          "type": "number",
          "description": "同屏判定时间窗口（分钟，默认 30）：同一实例内双方事件时间差 ≤ 该值即视为同屏"
        },
        "limit": {
          "type": "number",
          "description": "仅限制返回的 matches 条数（默认全量），不影响 matchCount/总时长统计"
        }
      },
      "required": [
        "userIdA",
        "userIdB"
      ]
    },
    handler: async (args) => handleGetFriendPairScreen(args)
  },
  {
    "name": "get_recent_cooplay",
    "description": "[query] 最近一起玩：查询最近 N 天与自己共同在场（同一实例且时间区间重叠）过的好友列表，按同屏次数降序。口径与 get_weekly_report 的同屏伙伴一致（北京自然日逐日区间重叠匹配合并）；返回 companions[{ userId, displayName, matchCount（共同在场段数）, daysCount（同屏天数）, lastDay（最近同屏日 MM-DD 北京） }]。days(1-90 默认 7)、limit(1-100 默认 30)。与 get_friend_pair_screen（两人版，带逐条 matches）互补——本工具是面向自己的全好友批量版。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "days": {
          "type": "number",
          "description": "回溯天数（1-90，默认 7）"
        },
        "limit": {
          "type": "number",
          "description": "返回条数上限（1-100，默认 30）"
        }
      }
    },
    handler: async (args) => handleGetRecentCooplay(args)
  },
  {
    "name": "get_ops_log",
    "description": "[query·运维] 查询服务运维日志（认证/WS/运维生命周期事件，保留最近 500 条）：返回 items[{ id, kind, level, message, createdAt }]。limit(1-1000 默认 200)、kind(可选 filter，'auth'|'ws'|'ops')。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "number",
          "description": "返回条数上限(1-1000，默认200)"
        },
        "kind": {
          "type": "string",
          "description": "类别过滤：auth|ws|ops（可选）"
        }
      }
    },
    handler: async (args) => handleGetOpsLog(args)
  },
  {
    "name": "get_friend_profile_changes",
    "description": "[query·资料] 好友资料变更历史（Avatar/Bio/状态/头像图标/代词）：事件管道实时采集 friend-update 的 user 对象 diff 落库，与 VRCX 迁移的 feed_avatar/feed_status/feed_bio 同 type 打通。userId 可选（省略=全部好友）；types 逗号分隔过滤（avatar/status/bio/user_icon/pronouns，默认全部）；limit(1-200)/offset 分页。返回每条 { userId, displayName, changeType, source, createdAt, change:{当前值, 旧值} }。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "userId": {
          "type": "string",
          "description": "Friend ID (usr_...). Omit to query all friends"
        },
        "limit": {
          "type": "number",
          "default": 50,
          "description": "Max rows (1-200, default 50)"
        },
        "offset": {
          "type": "number",
          "default": 0
        },
        "types": {
          "type": "string",
          "description": "Comma-separated change types: avatar/status/bio/user_icon/pronouns (default all)"
        }
      }
    },
    handler: async (args) => handleGetFriendProfileChanges(args)
  },
  {
    "name": "get_world_name",
    "description": "[query] Get world name by worldId. Checks local cache first, falls back to API.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "World ID (wrld_...)"
        },
        "forceRefresh": {
          "type": "boolean",
          "description": "Force refresh from API"
        }
      },
      "required": [
        "worldId"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleGetWorldName(args))
  },
  {
    "name": "get_worlds_by_author",
    "description": "[query] List worlds published by a single author, up to limit (default 100, max 500) — 通过作者 ID/作者名列出该作者的世界（最多 limit 张，默认 100，上限 500）. Resolves authorId by authorName via /users?search when authorName given, then lists worlds via GET /worlds?userId=<authorId> with offset pagination until exhausted or limit reached.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "authorId": {
          "type": "string",
          "description": "Author user ID (usr_...). Mutually exclusive with authorName."
        },
        "authorName": {
          "type": "string",
          "description": "Author display name — resolved to authorId via user search. Mutually exclusive with authorId."
        },
        "limit": {
          "type": "number",
          "default": 100,
          "description": "Max worlds to return (1-500, default 100)"
        }
      },
      "required": []
    },
    handler: async (args) => handleGetWorldsByAuthor(args)
  },
  {
    "name": "set_world_note",
    "description": "[manage] Set or update a user note for a world (stored locally, never overwritten by API refresh). Empty string clears the note.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "World ID (wrld_...)"
        },
        "note": {
          "type": "string",
          "description": "User note text; empty string clears"
        }
      },
      "required": [
        "worldId",
        "note"
      ]
    },
    handler: async (args) => handleSetWorldNote(args)
  },
  {
    "name": "get_world_history",
    "description": "[query] Get change history of a world's info (name, description, capacity, etc.).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "World ID (wrld_...)"
        },
        "limit": {
          "type": "number",
          "default": 50,
          "description": "Max history entries"
        }
      },
      "required": [
        "worldId"
      ]
    },
    handler: async (args) => handleGetWorldHistory(args)
  },
  {
    "name": "get_weekly_report",
    "description": "[query] Generate a weekly gaming report for the authenticated user: active days, play time, worlds visited, companion friends (with nicknames), own online pattern, group activities and friend group calendar. Data from local events DB + cached group info.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "days": {
          "type": "number",
          "default": 7,
          "description": "Report window in days (default 7)"
        }
      }
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleGetWeeklyReport(args), { taskTimeoutMs: 90000 })
  }
];
