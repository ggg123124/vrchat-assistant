/**
 * VRChat 好友监控系统 — SQLite 存储层
 * 
 * 封装 better-sqlite3 的所有数据库操作（2026-08-09 由 sql.js 迁移）。
 * 为什么换：sql.js 是 WASM 内存库，_save() 整文件覆盖写，强杀进程会
 * 截断 303MB 大文件导致数据全丢（2026-08-09 真实事故）。better-sqlite3
 * 是原生绑定 + WAL 模式：每次写即时落盘、崩溃安全、支持并发读。
 */
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { backupDatabase } from './backup.js';
import { SocialAnalytics } from './analytics/social.js';
import { WorldStore } from './domains/world-store.js';
import { CacheStore } from './domains/cache-store.js';
import { ContactsStore } from './domains/contacts-store.js';
import { XWorldsStore } from './domains/x-worlds-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DDL_PATH = path.join(__dirname, 'init-db.sql');
const X_WORLDS_DDL_PATH = path.join(__dirname, 'init-x-worlds.sql');
const SITE_WORLDS_DDL_PATH = path.join(__dirname, 'init-site-worlds.sql');

export class Storage {
  constructor() {
    this.social = new SocialAnalytics(this);
    this.world = new WorldStore(this);
    this.cache = new CacheStore(this);
    this.contacts = new ContactsStore(this);
    this.xWorlds = new XWorldsStore(this);
  }

  /** @type {import('better-sqlite3').Database} */
  db = null;
  dbPath = '';

  async init(dbPath) {
    this.dbPath = dbPath;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    const ddl = readFileSync(DDL_PATH, 'utf-8');
    // 迁移：旧库表名 new_worlds → world_kb（2026-08-16 更名，幂等）
    // ⚠️ 必须在 DDL exec 之前执行！否则 CREATE TABLE IF NOT EXISTS world_kb 会先建出
    // 空表，RENAME 因名字冲突失败，老数据残留在 new_worlds 中（代码全查 world_kb → 空）。
    // 顺序：老库（仅 new_worlds）→ RENAME 带走数据 + 索引跟随 → DDL 建 idx_world_kb_visited。
    const oldKbCols = this._query(`PRAGMA table_info(new_worlds)`);
    const newKbCols = this._query(`PRAGMA table_info(world_kb)`);
    if (oldKbCols.length > 0 && newKbCols.length === 0) {
      this._run(`ALTER TABLE new_worlds RENAME TO world_kb`);
      this._run(`DROP INDEX IF EXISTS idx_new_worlds_visited`);
    }
    this.db.exec(ddl);
    // X 博主世界推荐表（x_world_digest 工具，幂等 CREATE IF NOT EXISTS）
    try {
      const xddl = readFileSync(X_WORLDS_DDL_PATH, 'utf-8');
      this.db.exec(xddl);
    } catch (e) {
      console.warn(`[storage] x-worlds DDL 加载失败: ${e.message}`);
    }
<<<<<<< HEAD
    // 迁移：旧库 tracked_non_friends 缺状态列（非好友追踪在线状态展示，幂等）
    const tnfCols = this._query(`PRAGMA table_info(tracked_non_friends)`);
    if (!tnfCols.some(c => c.name === 'status')) {
      this._run(`ALTER TABLE tracked_non_friends ADD COLUMN status TEXT DEFAULT ''`);
    }
    if (!tnfCols.some(c => c.name === 'status_description')) {
      this._run(`ALTER TABLE tracked_non_friends ADD COLUMN status_description TEXT DEFAULT ''`);
    }
    if (!tnfCols.some(c => c.name === 'location')) {
      this._run(`ALTER TABLE tracked_non_friends ADD COLUMN location TEXT DEFAULT ''`);
    }
    if (!tnfCols.some(c => c.name === 'removed_at')) {
      this._run(`ALTER TABLE tracked_non_friends ADD COLUMN removed_at TEXT DEFAULT ''`);
    }
=======
    // 世界推荐网站分析表（world_analytics 工具）
    try {
      const sddl = readFileSync(SITE_WORLDS_DDL_PATH, 'utf-8');
      this.db.exec(sddl);
    } catch (e) {
      console.warn(`[storage] site-worlds DDL 加载失败: ${e.message}`);
    }
    // 迁移：旧库 site_world_recommendations 缺 created_at 列
    try {
      const sCols = this._query(`PRAGMA table_info(site_world_recommendations)`);
      if (!sCols.some(c => c.name === 'created_at')) {
        this.db.exec(`ALTER TABLE site_world_recommendations ADD COLUMN created_at TEXT DEFAULT ''`);
        console.warn('[storage] site_world_recommendations 已迁移：添加 created_at 列');
      }
    } catch (e) { /* 表不存在时忽略 */ }
>>>>>>> origin/main
    // 迁移：旧库 world_cache 缺 note 列
    const worldCols = this._query(`PRAGMA table_info(world_cache)`);
    if (!worldCols.some(c => c.name === 'note')) {
      this._run(`ALTER TABLE world_cache ADD COLUMN note TEXT`);
    }
    // 迁移：旧库 world_cache 缺 favorited 列（favorite_world 云端收藏本地标记，幂等）
    const wcFavCols = this._query(`PRAGMA table_info(world_cache)`);
    if (!wcFavCols.some(c => c.name === 'favorited')) {
      this._run(`ALTER TABLE world_cache ADD COLUMN favorited INTEGER DEFAULT 0`);
    }
    // 迁移：旧库 world_kb 缺 sleep_ok 列（recommend_join 睡觉图评分用，幂等）
    const nwCols = this._query(`PRAGMA table_info(world_kb)`);
    if (!nwCols.some(c => c.name === 'sleep_ok')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN sleep_ok INTEGER DEFAULT 0`);
    }
    // 迁移：旧库 join_choices 缺 world_tags 列（类型偏好学习用，幂等）
    const jcCols = this._query(`PRAGMA table_info(join_choices)`);
    if (!jcCols.some(c => c.name === 'world_tags')) {
      this._run(`ALTER TABLE join_choices ADD COLUMN world_tags TEXT DEFAULT ''`);
    }
    // 迁移：旧库 world_kb 缺 tags/description 列（scan_new_worlds upsert 依赖，幂等）
    const nwCols2 = this._query(`PRAGMA table_info(world_kb)`);
    if (!nwCols2.some(c => c.name === 'tags')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN tags TEXT DEFAULT ''`);
    }
    if (!nwCols2.some(c => c.name === 'description')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN description TEXT DEFAULT ''`);
    }
    // 迁移：旧库 world_kb 缺 user_rating 列（rate_world 用户反馈，幂等）
    const nwCols3 = this._query(`PRAGMA table_info(world_kb)`);
    if (!nwCols3.some(c => c.name === 'user_rating')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN user_rating INTEGER DEFAULT 0`);
    }
    // 迁移：旧库 world_kb 缺 author_id 列（作者维度推荐用，幂等）
    const nwCols4 = this._query(`PRAGMA table_info(world_kb)`);
    if (!nwCols4.some(c => c.name === 'author_id')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN author_id TEXT DEFAULT ''`);
    }
    // 迁移：旧库 world_kb 缺 backlog 系列列（待逛地图列表，幂等）
    const nwCols5 = this._query(`PRAGMA table_info(world_kb)`);
    if (!nwCols5.some(c => c.name === 'backlog')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN backlog INTEGER DEFAULT 0`);
    }
    if (!nwCols5.some(c => c.name === 'backlog_added_at')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN backlog_added_at TEXT`);
    }
    if (!nwCols5.some(c => c.name === 'backlog_reason')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN backlog_reason TEXT DEFAULT ''`);
    }
    if (!nwCols5.some(c => c.name === 'backlog_priority')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN backlog_priority INTEGER DEFAULT 0`);
    }
    // 迁移：world_kb.source 是死列（issue #78）——从未被写入/读取，仅靠误导性注释自我解释，
    // 与 events.source 同名易混淆，且 DDL 声称的「scan_new_worlds upsert 依赖」实际不存在。
    // 幂等删除：PRAGMA 判列存在再 DROP（SQLite ≥3.35 支持；better-sqlite3 已满足）。
    const nwCols6 = this._query(`PRAGMA table_info(world_kb)`);
    if (nwCols6.some(c => c.name === 'source')) {
      this._run(`ALTER TABLE world_kb DROP COLUMN source`);
    }
    // 迁移：历史 tags='' 脏数据统一为 '[]'（json_each 对空串抛 malformed JSON，Review R2）
    this._run(`UPDATE world_kb SET tags = '[]' WHERE tags IS NULL OR tags = ''`);
    // 迁移：旧库 friends 缺 bio/user_icon/pronouns 列（friend-profile 变更追踪用，幂等）
    const friendCols = this._query(`PRAGMA table_info(friends)`);
    if (!friendCols.some(c => c.name === 'bio')) {
      this._run(`ALTER TABLE friends ADD COLUMN bio TEXT`);
    }
    if (!friendCols.some(c => c.name === 'user_icon')) {
      this._run(`ALTER TABLE friends ADD COLUMN user_icon TEXT`);
    }
    if (!friendCols.some(c => c.name === 'pronouns')) {
      this._run(`ALTER TABLE friends ADD COLUMN pronouns TEXT`);
    }
    return this;
  }

  // better-sqlite3 每次写操作即时落盘（WAL），无需手动保存。
  // 保留为 no-op 兼容旧调用方（save()/close()）。
  _save() {}

  // better-sqlite3 绑定键不带 $ 前缀（SQL 里 $x 对应对象键 x）
  _normParams(params = {}) {
    const out = {};
    for (const [k, v] of Object.entries(params)) {
      out[k.startsWith('$') ? k.slice(1) : k] = v;
    }
    return out;
  }

  _query(sql, params = {}) {
    if (Object.keys(params).length > 0) {
      return this.db.prepare(sql).all(this._normParams(params));
    }
    return this.db.prepare(sql).all();
  }

  _run(sql, params = {}) {
    if (Object.keys(params).length > 0) {
      this.db.prepare(sql).run(this._normParams(params));
    } else {
      this.db.prepare(sql).run();
    }
  }

  // 公开薄封装（消除外部对 this.db / _query / _run 的直接耦合）
  query(sql, params = {}) {
    if (Object.keys(params).length > 0) {
      return this.db.prepare(sql).all(this._normParams(params));
    }
    return this.db.prepare(sql).all();
  }

  run(sql, params = {}) {
    if (params !== undefined && Object.keys(params).length > 0) {
      return this.db.prepare(sql).run(this._normParams(params));
    }
    return this.db.prepare(sql).run();
  }

  get(sql, params = {}) {
    return this.db.prepare(sql).get(this._normParams(params));
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  transaction(fn) {
    return this.db.transaction(fn);
  }

  backup(dir) {
    return backupDatabase(this.db, dir);
  }

  // ── 事件流 ──

  insertEvent({ type, userId, displayName, contentJson, worldId, worldName, createdAt, source = 'websocket' }) {
    this._run(
      `INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
       VALUES ($type, $userId, $displayName, $contentJson, $worldId, $worldName, $createdAt, $source)`,
      { $type: type, $userId: userId, $displayName: displayName || '', $contentJson: JSON.stringify(contentJson), $worldId: worldId || '', $worldName: worldName || '', $createdAt: createdAt, $source: source }
    );
  }

  insertEventsBatch(events) {
    const stmt = this.db.prepare(
      `INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
       VALUES ($type, $userId, $displayName, $contentJson, $worldId, $worldName, $createdAt, $source)`
    );
    for (const e of events) {
      stmt.run(this._normParams({
        $type: e.type, $userId: e.userId, $displayName: e.displayName || '',
        $contentJson: JSON.stringify(e.contentJson || {}),
        $worldId: e.worldId || '', $worldName: e.worldName || '',
        $createdAt: e.createdAt, $source: e.source || 'migrate',
      }));
    }
  }

  getEventsByUser(userId, { limit = 50, offset = 0, type } = {}) {
    let sql = `SELECT * FROM events WHERE user_id = $userId`;
    const params = { $userId: userId };
    if (type) { sql += ` AND type = $type`; params.$type = type; }
    sql += ` ORDER BY created_at DESC LIMIT $limit OFFSET $offset`;
    params.$limit = limit;
    params.$offset = offset;
    return this._query(sql, params);
  }

  /**
   * 批量取多个用户各自最新一条 friend-location 事件（get_online_friends 停留时长用）。
   * 返回 Map<userId, {createdAt, content}>；某用户无事件则不在 Map 中。
   * 窗口函数 PARTITION BY user_id 一次查询拿全，避免 N 次点查。
   */
  getLatestFriendLocations(userIds) {
    if (!userIds || userIds.length === 0) return new Map();
    const ph = userIds.map((_, i) => `$u${i}`).join(',');
    const params = {};
    userIds.forEach((id, i) => { params[`$u${i}`] = id; });
    const rows = this._query(
      `SELECT user_id, created_at, content_json FROM (
         SELECT user_id, created_at, content_json,
                ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
         FROM events
         WHERE type = 'friend-location' AND user_id IN (${ph})
       ) WHERE rn = 1`,
      params
    );
    const map = new Map();
    for (const r of rows) map.set(r.user_id, { createdAt: r.created_at, content: r.content_json });
    return map;
  }

  /**
   * 批量取每个用户本次在线会话的起点（get_online_friends 在线时长用，2026-08-16 新增）。
   * 口径：会话起点 = 最近一次 friend-offline 之后最早的一条 friend-online。
   * 为何不能直接取最新 friend-online：VRChat WS 重连/状态同步会重复推送 friend-online
   * （实测 24h 527 条 vs ~30 人在线），最新一条会严重低估时长；MIN(>last_off) 天然跳过重复推送。
   * 仅当用户从未有过 offline 记录时才取最早一条 friend-online（数据库记录以来首次上线）；
   * 有 offline 但 offline 后无 online（事件丢失/数据不一致）→ 返回 NULL，调用方安全降级
   * （避免把离线前时间当会话起点导致 onlineMinutes 高估，PR #36 审核 W1）。
   * 返回 Map<userId, sessionStartIso|null>；无 friend-online 事件则不在 Map 中。
   */
  getOnlineSessionStarts(userIds) {
    if (!userIds || userIds.length === 0) return new Map();
    const ph = userIds.map((_, i) => `$u${i}`).join(',');
    const params = {};
    userIds.forEach((id, i) => { params[`$u${i}`] = id; });
    const rows = this._query(
      `WITH offs AS (
         SELECT user_id, MAX(created_at) AS last_off FROM events
         WHERE type='friend-offline' AND user_id IN (${ph}) GROUP BY user_id
       )
       SELECT e.user_id,
              CASE WHEN o.last_off IS NULL THEN MIN(e.created_at)
                   ELSE MIN(CASE WHEN e.created_at > o.last_off THEN e.created_at END) END
              AS session_start
       FROM events e
       LEFT JOIN offs o ON e.user_id = o.user_id
       WHERE e.type = 'friend-online' AND e.user_id IN (${ph})
       GROUP BY e.user_id`,
      params
    );
    const map = new Map();
    for (const r of rows) map.set(r.user_id, r.session_start || null);
    return map;
  }

  getRecentEvents({ limit = 50, type } = {}) {
    let sql = `SELECT * FROM events`;
    const params = {};
    if (type) { sql += ` WHERE type = $type`; params.$type = type; }
    sql += ` ORDER BY created_at DESC LIMIT $limit`;
    params.$limit = limit;
    return this._query(sql, params);
  }

  getEventsByTimeRange(start, end, { limit = 1000 } = {}) {
    return this._query(
      `SELECT * FROM events WHERE created_at >= $start AND created_at <= $end ORDER BY created_at DESC LIMIT $limit`,
      { $start: start, $end: end, $limit: limit }
    );
  }

  countEventsByUserInRange(userId, start, end) {
    return this._query(
      `SELECT type, COUNT(*) as count FROM events WHERE user_id = $userId AND created_at >= $start AND created_at <= $end GROUP BY type`,
      { $userId: userId, $start: start, $end: end }
    );
  }

  // ── 好友状态 ──

  upsertFriend(friend) {
    const userId = friend.userId;
    // 只更新显式传入的字段：partial upsert（如 friend-location/friend-active 事件只带少数字段）
    // 不得覆盖未传的 profile 字段。历史 bug（PR #56 审查实测复现）：location 事件穿插会
    // 把 bio/status/avatar_image_url 等用 '' 覆盖，导致资料变更追踪基线被清空、main 上
    // status/avatar 数据同源丢失。故按 key 存在性动态构建 SET 子句。
    const columns = {
      display_name: 'displayName',
      memo: 'memo',
      trust_level: 'trustLevel',
      is_online: 'isOnline',
      location: 'location',
      world_id: 'worldId',
      world_name: 'worldName',
      platform: 'platform',
      status: 'status',
      status_description: 'statusDescription',
      avatar_image_url: 'avatarImageUrl',
      bio: 'bio',
      user_icon: 'userIcon',
      pronouns: 'pronouns',
      last_seen: 'lastSeen',
      last_online: 'lastOnline',
      last_offline: 'lastOffline',
    };
    const norm = {
      displayName: v => v || '',
      memo: v => v ?? null,
      trustLevel: v => v ?? null,
      isOnline: v => v ? 1 : 0,
      location: v => v || '',
      worldId: v => v || '',
      worldName: v => v || '',
      platform: v => v || '',
      status: v => v || '',
      statusDescription: v => v || '',
      avatarImageUrl: v => v || '',
      bio: v => v || '',
      userIcon: v => v || '',
      pronouns: v => v || '',
      lastSeen: v => v || '',
      lastOnline: v => v || '',
      lastOffline: v => v || '',
    };

    const setCols = [];
    const params = { $userId: userId };
    for (const [col, key] of Object.entries(columns)) {
      if (friend[key] === undefined) continue;  // 未传 → 不更新该列
      params[`$${col}`] = norm[key](friend[key]);
      setCols.push(`${col}=COALESCE($${col}, ${col})`);
    }
    if (setCols.length === 0) return;

    const insCols = ['user_id', ...Object.keys(columns).filter(c => friend[columns[c]] !== undefined)];
    const insPh = insCols.map(c => c === 'user_id' ? '$userId' : `$${c}`);

    this._run(
      `INSERT INTO friends (${insCols.join(', ')})
       VALUES (${insPh.join(', ')})
       ON CONFLICT(user_id) DO UPDATE SET
        ${setCols.join(', ')}${setCols.length ? ',' : ''}
        updated_at=datetime('now')`,
      params
    );
  }

  getAllFriends() {
    return this._query(`SELECT * FROM friends ORDER BY display_name`);
  }

  getOnlineFriends() {
    return this._query(`SELECT * FROM friends WHERE is_online = 1 ORDER BY display_name`);
  }

  getFriend(userId) {
    const rows = this._query(`SELECT * FROM friends WHERE user_id = $userId`, { $userId: userId });
    return rows[0] || null;
  }

  // 好友资料变更历史（friend-profile 变更追踪，2026-08-19 新增）
  // 查询 events 表中 content_json.type 为 avatar/status/bio/user_icon/pronouns 的记录。
  // 与 VRCX 迁移脚本（feed_avatar/feed_status/feed_bio）写入格式一致：顶层 type='friend-update'，
  // 实际变更类型在 content_json.type 里。types 参数逗号分隔过滤（默认全部）。
  getFriendProfileChanges(userId, { limit = 50, offset = 0, types } = {}) {
    const validTypes = ['avatar', 'status', 'bio', 'user_icon', 'pronouns'];
    let typesArr = validTypes;
    if (types) {
      typesArr = String(types).split(',').map(t => t.trim()).filter(t => validTypes.includes(t));
      if (typesArr.length === 0) typesArr = validTypes;
    }
    const params = { $limit: limit, $offset: offset };
    const placeholders = typesArr.map((t, i) => { params[`$t${i}`] = t; return `$t${i}`; }).join(',');
    let sql = `SELECT * FROM events WHERE type = 'friend-update'
               AND json_extract(content_json, '$.type') IN (${placeholders})`;
    if (userId) { sql += ` AND user_id = $userId`; params.$userId = userId; }
    sql += ` ORDER BY created_at DESC LIMIT $limit OFFSET $offset`;
    return this._query(sql, params);
  }

  getFriendProfileChangeCount(userId, { types } = {}) {
    const validTypes = ['avatar', 'status', 'bio', 'user_icon', 'pronouns'];
    let typesArr = validTypes;
    if (types) {
      typesArr = String(types).split(',').map(t => t.trim()).filter(t => validTypes.includes(t));
      if (typesArr.length === 0) typesArr = validTypes;
    }
    const params = {};
    const placeholders = typesArr.map((t, i) => { params[`$t${i}`] = t; return `$t${i}`; }).join(',');
    let sql = `SELECT COUNT(*) n FROM events WHERE type = 'friend-update'
               AND json_extract(content_json, '$.type') IN (${placeholders})`;
    if (userId) { sql += ` AND user_id = $userId`; params.$userId = userId; }
    return this._query(sql, params)[0].n;
  }

  searchFriends(query) {
    return this._query(
      `SELECT * FROM friends WHERE display_name LIKE $q OR memo LIKE $q ORDER BY display_name LIMIT 50`,
      { $q: `%${query}%` }
    );
  }

  // ── 配置 ──

  getConfig(key, defaultValue = null) {
    const rows = this._query(`SELECT value FROM config WHERE key = $key`, { $key: key });
    return rows.length > 0 ? rows[0].value : defaultValue;
  }

  setConfig(key, value) {
    this._run(`INSERT OR REPLACE INTO config (key, value) VALUES ($key, $value)`, { $key: key, $value: String(value) });
  }

  // ── 工具方法 ──

  // ── 社交分析转发（核心实现在 core/analytics/social.js）──

  findCompanions(...args) { return this.social.findCompanions(...args); }
  findFriendPairScreen(...args) { return this.social.findFriendPairScreen(...args); }
  findFriendPairMeetings(...args) { return this.social.findFriendPairMeetings(...args); }
  getOnlinePattern(...args) { return this.social.getOnlinePattern(...args); }
  getOwnWorldSessions(...args) { return this.social.getOwnWorldSessions(...args); }
  getWeeklyCompanions(...args) { return this.social.getWeeklyCompanions(...args); }
  getFriendGroupStats(...args) { return this.social.getFriendGroupStats(...args); }

  // ── 运维日志（认证/连接生命周期）──

  insertOpsLog({ kind, level = 'info', message, createdAt }) {
    this._run(
      `INSERT INTO ops_log (kind, level, message, created_at) VALUES ($kind, $level, $message, $createdAt)`,
      { $kind: kind, $level: level, $message: String(message).slice(0, 500), $createdAt: createdAt || new Date().toISOString() }
    );
    // 保留策略：只留最近 500 条（写入即裁剪，幂等）
    this._run(`DELETE FROM ops_log WHERE id <= (SELECT id FROM ops_log ORDER BY id DESC LIMIT 1 OFFSET 500)`);
  }

  getOpsLog({ limit = 200, kind } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    if (kind) {
      return this._query(`SELECT * FROM ops_log WHERE kind = $kind ORDER BY id DESC LIMIT $lim`, { $kind: kind, $lim: lim });
    }
    return this._query(`SELECT * FROM ops_log ORDER BY id DESC LIMIT $lim`, { $lim: lim });
  }

  getStats() {
    const result = {};
    for (const table of ['events', 'friends', 'world_cache', 'watchlist']) {
      const rows = this._query(`SELECT COUNT(*) as count FROM ${table}`);
      result[table] = rows[0]?.count || 0;
    }
    result.eventTypes = this._query(`SELECT type, COUNT(*) as count FROM events GROUP BY type ORDER BY count DESC`);
    return result;
  }

  save() { this._save(); }
  close() { this._save(); this.db.close(); }

  // ── world 域转发（核心实现在 core/domains/world-store.js）──

  getWorldName(...args) { return this.world.getWorldName(...args); }
  searchWorldsByName(...args) { return this.world.searchWorldsByName(...args); }
  _recordWorldChanges(...args) { return this.world._recordWorldChanges(...args); }
  upsertWorld(...args) { return this.world.upsertWorld(...args); }
  upsertWorldsBatch(...args) { return this.world.upsertWorldsBatch(...args); }
  setWorldNote(...args) { return this.world.setWorldNote(...args); }
  setWorldFavorited(...args) { return this.world.setWorldFavorited(...args); }
  rateWorld(...args) { return this.world.rateWorld(...args); }
  markWorldVisited(...args) { return this.world.markWorldVisited(...args); }
  setWorldSleep(...args) { return this.world.setWorldSleep(...args); }
  addToBacklog(...args) { return this.world.addToBacklog(...args); }
  removeFromBacklog(...args) { return this.world.removeFromBacklog(...args); }
  getWorldKbInfo(...args) { return this.world.getWorldKbInfo(...args); }
  backfillWorldKbInfo(...args) { return this.world.backfillWorldKbInfo(...args); }
  getBacklog(...args) { return this.world.getBacklog(...args); }
  getWorldHistory(...args) { return this.world.getWorldHistory(...args); }

<<<<<<< HEAD
  // ── cache 域转发（核心实现在 core/domains/cache-store.js）──
=======
  insertXWorld({ worldId, worldName, authorName, description, imageUrl, favorites, visits, popularity, capacity, tags, firstSeenAt, lastRecommendedAt, creators, tweetCount }) {
    this._run(
      `INSERT OR REPLACE INTO x_world_recommendations
        (world_id, world_name, author_name, description, image_url, favorites, visits, popularity, capacity, tags,
         first_seen_at, last_recommended_at, creators, tweet_count)
       VALUES ($worldId, $worldName, $authorName, $description, $imageUrl, $favorites, $visits, $popularity, $capacity, $tags,
         $firstSeenAt, $lastRecommendedAt, $creators, $tweetCount)`,
// ---- 上游新增 ----
      `INSERT INTO x_world_recommendations
        (world_id, world_name, author_name, description, image_url, favorites, visits, popularity, capacity, tags,
         first_seen_at, last_recommended_at, creators, tweet_count)
       VALUES ($worldId, $worldName, $authorName, $description, $imageUrl, $favorites, $visits, $popularity, $capacity, $tags,
         $firstSeenAt, $lastRecommendedAt, $creators, $tweetCount)
       ON CONFLICT(world_id) DO UPDATE SET
         world_name = $worldName, author_name = $authorName, description = $description, image_url = $imageUrl,
         favorites = $favorites, visits = $visits, popularity = $popularity, capacity = $capacity, tags = $tags,
         last_recommended_at = $lastRecommendedAt, tweet_count = $tweetCount`,
      {
        $worldId: worldId, $worldName: worldName || '', $authorName: authorName || '',
        $description: description || '', $imageUrl: imageUrl || '',
        $favorites: favorites || 0, $visits: visits || 0, $popularity: popularity || 0,
        $capacity: capacity || 0, $tags: tags || '[]',
        $firstSeenAt: firstSeenAt || new Date().toISOString(),
        $lastRecommendedAt: lastRecommendedAt || new Date().toISOString(),
        $creators: creators || '[]', $tweetCount: tweetCount || 1,
      }
    );
  }
>>>>>>> origin/main

  getZhTranslations(...args) { return this.cache.getZhTranslations(...args); }
  setZhTranslation(...args) { return this.cache.setZhTranslation(...args); }
  getGroupCached(...args) { return this.cache.getGroupCached(...args); }
  upsertGroupCache(...args) { return this.cache.upsertGroupCache(...args); }
  getPlanetCache(...args) { return this.cache.getPlanetCache(...args); }
  setPlanetCache(...args) { return this.cache.setPlanetCache(...args); }
  getGroupHeat(...args) { return this.cache.getGroupHeat(...args); }
  upsertBoothItem(...args) { return this.cache.upsertBoothItem(...args); }
  getBoothItemCache(...args) { return this.cache.getBoothItemCache(...args); }
  listBoothItems(...args) { return this.cache.listBoothItems(...args); }
  recordBoothSearch(...args) { return this.cache.recordBoothSearch(...args); }
  getBoothSearches(...args) { return this.cache.getBoothSearches(...args); }

  // ── contacts 域转发（核心实现在 core/domains/contacts-store.js）──

  addToWatchlist(...args) { return this.contacts.addToWatchlist(...args); }
  removeFromWatchlist(...args) { return this.contacts.removeFromWatchlist(...args); }
  getWatchlist(...args) { return this.contacts.getWatchlist(...args); }
  getNicknames(...args) { return this.contacts.getNicknames(...args); }
  setNickname(...args) { return this.contacts.setNickname(...args); }

<<<<<<< HEAD
  // ── xWorlds 域转发（核心实现在 core/domains/x-worlds-store.js）──

  getXWorld(...args) { return this.xWorlds.getXWorld(...args); }
  insertXWorld(...args) { return this.xWorlds.insertXWorld(...args); }
  updateXWorld(...args) { return this.xWorlds.updateXWorld(...args); }
  getXWorldsSince(...args) { return this.xWorlds.getXWorldsSince(...args); }
  getAllXWorlds(...args) { return this.xWorlds.getAllXWorlds(...args); }
  clearXWorlds(...args) { return this.xWorlds.clearXWorlds(...args); }
=======
  clearXWorlds() {
    this._run(`DELETE FROM x_world_recommendations`);
  }

  // ── 世界推荐网站分析（world_analytics） ──

  upsertSiteWorld({ worldId, worldName, authorName, description, imageUrl, favorites, visits, popularity, capacity, tags, source, sourceId, sourceUrl, sourceDate, category, createdAt }) {
    this._run(
      `INSERT INTO site_world_recommendations
        (world_id, world_name, author_name, description, image_url, favorites, visits, popularity, capacity, tags,
         source, source_id, source_url, source_date, created_at, category, first_seen_at, last_seen_at)
       VALUES ($worldId, $worldName, $authorName, $description, $imageUrl, $favorites, $visits, $popularity, $capacity, $tags,
         $source, $sourceId, $sourceUrl, $sourceDate, $createdAt, $category, datetime('now'), datetime('now'))
       ON CONFLICT(world_id, source) DO UPDATE SET
         world_name = $worldName, author_name = $authorName, description = $description, image_url = $imageUrl,
         favorites = $favorites, visits = $visits, popularity = $popularity, capacity = $capacity, tags = $tags,
         source_url = $sourceUrl, source_date = $sourceDate, created_at = $createdAt, category = $category, last_seen_at = datetime('now')`,
      {
        $worldId: worldId, $worldName: worldName || '', $authorName: authorName || '',
        $description: description || '', $imageUrl: imageUrl || '',
        $favorites: favorites || 0, $visits: visits || 0, $popularity: popularity || 0,
        $capacity: capacity || 0, $tags: tags || '[]',
        $source: source || 'planetvrchat', $sourceId: sourceId || '', $sourceUrl: sourceUrl || '',
        $sourceDate: sourceDate || '', $createdAt: createdAt || '', $category: category || '',
      }
    );
  }

  logSiteScan({ scanDate, source, worldId, worldName, favorites, visits, popularity }) {
    this._run(
      `INSERT OR IGNORE INTO site_world_scan_log (scan_date, source, world_id, world_name, favorites, visits, popularity)
       VALUES ($scanDate, $source, $worldId, $worldName, $favorites, $visits, $popularity)`,
      {
        $scanDate: scanDate, $source: source || 'planetvrchat',
        $worldId: worldId, $worldName: worldName || '',
        $favorites: favorites || 0, $visits: visits || 0, $popularity: popularity || 0,
      }
    );
  }

  getSiteWorlds({ sinceDate, sinceCreatedAt, category, sortBy = 'favorites', limit = 50 } = {}) {
    let sql = `SELECT * FROM site_world_recommendations WHERE 1=1`;
    const params = {};
    if (sinceDate) { sql += ` AND source_date >= $sinceDate`; params.$sinceDate = sinceDate; }
    // 按世界真实创建时间过滤（VRChat created_at）——"新图"用这个
    if (sinceCreatedAt) { sql += ` AND created_at >= $sinceCreatedAt`; params.$sinceCreatedAt = sinceCreatedAt; }
    if (category) { sql += ` AND category = $category`; params.$category = category; }
    const sorters = {
      favorites: `ORDER BY favorites DESC`,
      visits: `ORDER BY visits DESC`,
      popularity: `ORDER BY popularity DESC`,
      favorites_ratio: `ORDER BY (favorites * 1.0 / NULLIF(visits, 0)) DESC`,
    };
    sql += ` ` + (sorters[sortBy] || sorters.favorites);
    sql += ` LIMIT $limit`;
    params.$limit = limit;
    return this._query(sql, params);
  }

  getSiteWorldHistory(worldId, source = 'planetvrchat') {
    return this._query(
      `SELECT * FROM site_world_scan_log WHERE world_id = $worldId AND source = $source ORDER BY scan_date ASC`,
      { $worldId: worldId, $source: source }
    );
  }

  getSiteScanDates(limit = 30) {
    return this._query(
      `SELECT DISTINCT scan_date FROM site_world_scan_log ORDER BY scan_date DESC LIMIT $limit`,
      { $limit: limit }
    );
  }

  clearSiteWorlds() {
    this._run(`DELETE FROM site_world_recommendations`);
    this._run(`DELETE FROM site_world_scan_log`);
  }
>>>>>>> origin/main
}
