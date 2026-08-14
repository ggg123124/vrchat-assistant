/**
 * 新世界扫描核心逻辑（MCP handler 与 CLI 共用）
 *
 * 本模块不含认证、数据库、OTP 等副作用，只负责：
 * - 垃圾世界过滤规则
 * - 热度评分
 * - 分类（未逛 / 已逛 / 待新增 / 已跟踪）
 * - 按时间窗口翻页拉取候选世界
 */

/**
 * 过滤测试图/垃圾图/开发中世界
 * 规则：名字含测试关键词（子串），或作者信息缺失，或容量异常
 * @param {object} w VRChat world 对象
 * @returns {boolean}
 */
export function isJunkWorld(w) {
  const name = (w.name || '').toLowerCase().trim();
  const junkPatterns = [
    /test/i, /测试/i, /習作/i, /习作/i, /sample/i, /示例/i,
    /placeholder/i, /wip/i, /untitled/i, /tmp/i, /temp/i,
    /new world/i, /新建世界/i, /frist create/i, /first create/i,
    /^0+[0-9]{0,3}$/, /^room\d*$/i, /^a room$/i, /^\[?beta\]?$/i,
    /unity input/i, /tutorial/i, /sdk test/i, /do not use/i,
  ];
  const hitJunk = junkPatterns.some(re => re.test(name));
  const hasAuthor = w.authorName && w.authorName !== 'Unknown' && w.authorName !== 'unknown';
  return (
    hitJunk ||
    !hasAuthor ||
    (typeof w.capacity === 'number' && w.capacity < 4)
  );
}

/**
 * 热度评分：收藏数*2 + 在线人数*10 + 热度分 + 用户反馈加权（Issue #19）
 * userRating: 1(好图) +50 加权；-1(烂图) -100 降权（推荐排序时实际会被甩到后面）
 * @param {object} w VRChat world 对象（可含 userRating 字段）
 * @returns {number}
 */
export function worldScore(w) {
  const rating = (w.userRating !== undefined && w.userRating !== null) ? w.userRating : 0;
  const ratingBias = rating === 1 ? 50 : (rating === -1 ? -100 : 0);
  return (w.favorites || 0) * 2 + (w.occupants || 0) * 10 + (w.popularity || 0) + ratingBias;
}

/**
 * 把拉取到的世界按「是否逛过 / 是否已跟踪」分类
 * @param {object[]} fresh 过滤后的新世界列表
 * @param {Set<string>} visitedSet 用户已逛的世界 id 集合
 * @param {Set<string>} trackedSet 已跟踪的世界 id 集合
 * @returns {{unvisited: object[], visitedFresh: object[], toAdd: object[], alreadyTracked: object[]}}
 */
export function classifyWorlds(fresh, visitedSet, trackedSet) {
  const unvisited = fresh.filter(w => !visitedSet.has(w.id));
  const visitedFresh = fresh.filter(w => visitedSet.has(w.id));
  const toAdd = unvisited.filter(w => !trackedSet.has(w.id));
  const alreadyTracked = fresh.filter(w => trackedSet.has(w.id));
  return { unvisited, visitedFresh, toAdd, alreadyTracked };
}

/**
 * 翻页拉取候选世界，并按窗口、标签、发布状态、垃圾规则过滤
 * @param {object} api VrchatApiClient 实例（需已认证）
 * @param {object} rateLimiter RateLimiter 实例
 * @param {object} options
 * @param {number} options.days 回溯天数
 * @param {number} [options.maxFetch=200] 最大拉取条数
 * @returns {{fresh: object[], candidates: object[]}}
 */
export async function fetchFreshWorlds(api, rateLimiter, { days, maxFetch = 200 }) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const candidates = [];

  for (let offset = 0; offset < maxFetch; offset += 100) {
    const r = await rateLimiter.execute(() =>
      api._request('GET', `/worlds?sort=created&order=descending&n=100&offset=${offset}`));
    if (r.status !== 200 || !Array.isArray(r.data) || r.data.length === 0) break;
    candidates.push(...r.data);
    if (r.data.length < 100) break;
  }

  const fresh = candidates
    .filter(w => {
      const created = new Date(w.created_at);
      return created >= cutoff &&
        Array.isArray(w.tags) &&
        w.tags.includes('system_created_recently');
    })
    .filter(w => w.releaseStatus === 'public')
    .filter(w => !isJunkWorld(w));

  return { candidates, fresh };
}
