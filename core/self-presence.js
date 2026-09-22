/**
 * 自我在场判定（self presence）—— core 共享模块
 * =====================================================================
 * 用途：把「使用者自己是否在游戏内」从 events 表的 user-location 事件推导出来，
 * 供核心（dashboard 服务）与插件（经 api.consume）共用，避免多处各写一份判定。
 *
 * 数据来源与语义：
 *   - VRChat 的 WebSocket pipeline 会推送**自己账号**的位置变化（事件类型
 *     `user-location`，content.location 形如 "wrld_xxx:123~hidden(usr)~region(jp)"）。
 *     只登录网页端 / API 时为 "offline:offline"（服务自身常驻登录即此状态）。
 *   - 因此「最近一条 user-location」就是自己是否在游戏内的唯一权威信号。
 *
 * 三态语义（消费方按需映射）：
 *   - 'in_game'     在游戏内（位置是 wrld_ / traveling / private|friends|group|local，
 *                   且新鲜度在 staleMs 内——超时无法确认"仍在"，降级为 unknown）
 *   - 'not_in_game' 明确不在游戏内（offline / offline:offline / 空位置）
 *   - 'unknown'     无法判定（无 selfId、无 user-location 记录、位置解析失败、
 *                   或在游戏态但记录陈旧）——**消费方应保守处理，不要据此翻转行为**
 *
 * 与既有 `dashboard.isSelfOnline` 的关系：该服务是本法的一个薄映射
 * （in_game→true / not_in_game→false / unknown→null），二者共用本模块，行为不变。
 */

/** 在游戏内但超过该时长无新位置事件 → 无法确认仍在游戏内（降级 unknown） */
export const SELF_PRESENCE_STALE_MS = 60 * 60 * 1000;

// 出游戏确认窗口（issue #218，2026-09-22）：VRChat 在私人房之间切换 / 换图间隙会瞬时上报
// `offline:offline`（生产实测两种形态：0.6–11.7s 居多，也存在 349s / 352.5s 一档）。单次离线
// 信号不足以判定「真的离开」——离线信号**持续**不足该窗口时返回 unknown（消费方据此跳过，
// 不写挂机文案、不翻转判定态），持续超过窗口才判 not_in_game。
// ⚠️ 边界：只能抑制「时长 ≤ 窗口」的瞬断；真出游戏后写挂机文案会相应延后最多一个窗口。
// env 在调用时读取，便于测试与热调；设 0 恢复旧行为（单次离线即判出游戏）。
export const SELF_PRESENCE_OFFLINE_GRACE_DEFAULT_MS = 6 * 60 * 1000;   // 默认 6 分钟，覆盖已观测到的 349 / 352.5s 档

/** 出游戏确认窗口（毫秒）：env VRC_MONITOR_SELF_PRESENCE_OFFLINE_GRACE_SECONDS（默认 360s，范围 0-3600），调用时读取。 */
export function readOfflineGraceMs() {
  const n = Number(process.env.VRC_MONITOR_SELF_PRESENCE_OFFLINE_GRACE_SECONDS);
  if (!Number.isFinite(n)) return SELF_PRESENCE_OFFLINE_GRACE_DEFAULT_MS;
  return Math.min(3600, Math.max(0, n)) * 1000;
}

/** 非 wrld_ 的"在游戏内"位置前缀（实例可见性为 private/friends 等时 VRChat 不下发 worldId） */
export const IN_GAME_LOCATION_RE = /^(private|friends|group|local)\b/;

/**
 * 从位置字符串解析 worldId（仅 wrld_ 前缀的位置有；private/offline 等返回空串）。
 * @param {string} location
 * @returns {string}
 */
export function worldIdFromSelfLocation(location) {
  return typeof location === 'string' && location.startsWith('wrld_') ? location.split(':')[0] : '';
}

/**
 * 判定自己的在场状态。
 *
 * @param {{query: (sql: string, params?: any) => any[]}} storage 核心 storage（只需 query）
 * @param {object} [opts]
 * @param {string} [opts.selfId]  自己的 userId；缺省时不做推导（消费方用 getSelfUserId 推导后传入）
 * @param {number} [opts.now]     当前时间戳（测试可注入）
 * @param {number} [opts.staleMs] 在游戏态的新鲜度阈值
 * @returns {{userId: string, state: 'in_game'|'not_in_game'|'unknown', location: string,
 *            worldId: string, at: string, ageMs: number|null}}
 */
export function resolveSelfPresence(storage, {
  selfId = '', now = Date.now(), staleMs = SELF_PRESENCE_STALE_MS,
  offlineGraceMs = readOfflineGraceMs(),
} = {}) {
  const base = { userId: selfId || '', state: 'unknown', location: '', worldId: '', at: '', ageMs: null };
  if (!selfId || !storage || typeof storage.query !== 'function') return base;

  let row;
  try {
    row = storage.query(
      `SELECT content_json, created_at FROM events
        WHERE type = 'user-location' AND user_id = $self
        ORDER BY created_at DESC LIMIT 1`,
      { $self: selfId }
    )[0];
  } catch {
    return base;
  }
  if (!row) return base;

  let loc = '';
  try {
    loc = (JSON.parse(row.content_json || '{}').location) || '';
  } catch {
    return base;
  }

  const at = row.created_at || '';
  const atMs = Date.parse(at);
  const ageMs = Number.isFinite(atMs) ? Math.max(0, now - atMs) : null;

  // 明确离线：网页端在线（服务自身常驻登录）/ 空位置
  if (loc === '' || loc === 'offline' || loc === 'offline:offline') {
    // 未满确认窗口 → unknown：消费方（presence-status / events 离线刷新调度器 / dashboard）
    // 一律跳过，既不写挂机文案也不翻转判定态；满窗口才认为真的离开（issue #218）。
    if (ageMs !== null && ageMs < offlineGraceMs) {
      return { ...base, state: 'unknown', location: loc, at, ageMs };
    }
    return { ...base, state: 'not_in_game', location: loc, at, ageMs };
  }

  // 位置字段不是字符串（如 content_json 为 {"location":123}）→ 无法判定，不向上抛异常
  // （与重构前 dashboard.isSelfOnline 被外层 try/catch 兜成 null 的语义等价）
  if (typeof loc !== 'string') {
    return { ...base, state: 'unknown', at, ageMs };
  }

  // 在游戏内的形态：真实世界 / 传送中 / 无 worldId 的实例可见性
  if (loc.startsWith('wrld_') || loc === 'traveling' || IN_GAME_LOCATION_RE.test(loc)) {
    if (ageMs === null || ageMs > staleMs) {
      // 无法确认"仍在游戏内"→ 不翻转消费方行为
      return { ...base, state: 'unknown', location: loc, at, ageMs };
    }
    return { ...base, state: 'in_game', location: loc, worldId: worldIdFromSelfLocation(loc), at, ageMs };
  }

  return { ...base, state: 'unknown', location: loc, at, ageMs };
}
