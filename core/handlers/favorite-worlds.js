/**
 * 我的收藏世界分析 handler — get_my_favorite_worlds / get_my_favorite_groups
 *
 * 功能：拉取当前账号收藏的全部世界（VRChat /favorites?type=world），
 *       批量查询详情（名称/作者/描述/标签/收藏/浏览），按标签分类输出表格数据。
 * 认证：走服务端 ctx.api（已在启动时登录），不新建客户端。
 */

import { ctx, log } from '../server-context.js';

const PAGE = 100;

/**
 * 分页拉取全部收藏的世界
 * @returns {Promise<Array<{favoriteId, worldId, favoriteGroupName, favoriteTags, createdAt}>>}
 */
async function fetchAllFavoriteWorlds(api, rateLimiter) {
  const all = [];
  let offset = 0;
  while (true) {
    const r = await rateLimiter.execute(() => api._request('GET', `/favorites?type=world&n=${PAGE}&offset=${offset}`));
    if (r.status !== 200 || !Array.isArray(r.data)) {
      throw new Error(`favorites API ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    if (r.data.length === 0) break;
    for (const f of r.data) {
      all.push({
        favoriteId: f.favoriteId || '',
        // VRChat favorites API: favoriteId 是被收藏内容的 ID（world 类型为 wrld_）
        worldId: f.favoriteId || f.worldId || '',
        favoriteGroupName: f.favoriteGroupName || '',
        favoriteTags: Array.isArray(f.tags) ? f.tags : [],
        createdAt: f.createdAt || '',
      });
    }
    offset += PAGE;
    if (r.data.length < PAGE) break;
    if (offset >= 3000) break; // 安全阀
  }
  return all;
}

/**
 * 批量查询世界详情（ids 参数，每批最多 100 个）
 */
/**
 * 查询世界详情：优先本地缓存（site_world_recommendations），缺失的走 /worlds/{id} 单查
 */
async function fetchWorldDetails(api, rateLimiter, storage, ids) {
  const map = new Map();
  const missing = [];

  // 1) 本地缓存填充（之前扫描过的世界详情）
  for (const id of ids) {
    try {
      const rows = storage._query(`SELECT * FROM site_world_recommendations WHERE world_id = $id`, { $id: id });
      if (rows.length > 0) {
        const r = rows[0];
        map.set(id, {
          id,
          name: r.world_name,
          authorName: r.author_name,
          description: r.description,
          imageUrl: r.image_url,
          favorites: r.favorites,
          visits: r.visits,
          popularity: r.popularity,
          capacity: r.capacity,
          tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })(),
        });
      } else {
        missing.push(id);
      }
    } catch { missing.push(id); }
  }
  log(`[favorite-worlds] 本地缓存命中 ${map.size} 个，需 API 查询 ${missing.length} 个`);

  // 2) 缺失的逐个查 /worlds/{id}（VRChat ids 批量参数不可用，只能单查）
  for (const id of missing) {
    try {
      const r = await rateLimiter.execute(() => api._request('GET', `/worlds/${encodeURIComponent(id)}`));
      if (r.status === 200 && r.data) {
        map.set(id, r.data);
        // 顺手写入本地缓存，下次直接命中
        try {
          storage.upsertSiteWorld({
            worldId: id,
            worldName: r.data.name || '',
            authorName: r.data.authorName || '',
            description: (r.data.description || '').slice(0, 500),
            imageUrl: r.data.imageUrl || '',
            favorites: r.data.favorites || 0,
            visits: r.data.visits || 0,
            popularity: r.data.popularity || 0,
            capacity: r.data.capacity || 0,
            tags: JSON.stringify(Array.isArray(r.data.tags) ? r.data.tags : []),
            source: 'favorite-cache',
            sourceId: '', sourceUrl: '',
            sourceDate: (r.data.created_at || '').slice(0, 10),
            category: '',
            createdAt: r.data.created_at || '',
          });
        } catch { /* 缓存失败不影响 */ }
      }
    } catch { /* 单条失败跳过 */ }
  }
  log(`[favorite-worlds] 详情查询完成: ${ids.length} 个 → ${map.size} 个命中`);
  return map;
}

/** 世界标签 → 分类映射（优先级从高到低） */
const CATEGORY_RULES = [
  { re: /avatar|アバター|model|展示|改模|店/i, cat: 'Avatar/模型' },
  { re: /horror|怖|ホラー|backroom/i, cat: '恐怖' },
  { re: /game|ゲーム|fps|racing|race|puzzle|謎解き|udon/i, cat: '游戏' },
  { re: /music|音楽|dj|ライブ|concert|dance|舞/i, cat: '音乐/演出' },
  { re: /social|hangout|集合|club|バー|居酒屋|cafe|カフェ/i, cat: '社交/聚会' },
  { re: /photo|写真|撮影|カメラ/i, cat: '拍照' },
  { re: /vrcsleep|睡眠|寝る|sleep|chill|チル|relax/i, cat: '休闲/睡觉' },
  { re: /景観|景色|scenic|view|観光|landscape/i, cat: '风景/观光' },
];

function classify(world) {
  const name = (world.name || '') + ' ' + (world.description || '').slice(0, 200);
  const tags = Array.isArray(world.tags) ? world.tags.join(' ') : '';
  const haystack = name + ' ' + tags;
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(haystack)) return rule.cat;
  }
  return '其他';
}

/**
 * 获取我的收藏世界，按标签分类
 * @param {Object} args { limit, sortBy: 'favorites'|'name'|'visits' }
 */
export async function handleGetMyFavoriteWorlds({ limit = 500, sortBy = 'favorites' } = {}) {
  const { api, rateLimiter, storage } = ctx;
  try {
    // 1) 分页拉全部收藏世界
    const favs = await fetchAllFavoriteWorlds(api, rateLimiter);
    if (favs.length === 0) {
      return { ok: true, total: 0, categories: [], worlds: [], message: '没有收藏的世界' };
    }
    log(`[favorite-worlds] 收藏世界 ${favs.length} 个，开始批量查详情`);

    // 2) 查询详情（本地缓存优先，缺失的走 API 单查）
    const ids = favs.map(f => f.worldId).filter(Boolean);
    const detailMap = await fetchWorldDetails(api, rateLimiter, storage, ids);

    // 3) 组装
    const worlds = favs.map(f => {
      const w = detailMap.get(f.worldId) || {};
      return {
        worldId: f.worldId,
        worldName: w.name || '(未知)',
        authorName: w.authorName || '',
        description: (w.description || '').slice(0, 300),
        imageUrl: w.imageUrl || '',
        favorites: w.favorites || 0,
        visits: w.visits || 0,
        popularity: w.popularity || 0,
        capacity: w.capacity || 0,
        tags: Array.isArray(w.tags) ? w.tags : [],
        category: classify(w),
        favoriteGroup: f.favoriteGroupName || '',
      };
    });

    // 4) 按分类分组 + 组内排序
    const sorters = {
      favorites: (a, b) => b.favorites - a.favorites,
      visits: (a, b) => b.visits - a.visits,
      name: (a, b) => a.worldName.localeCompare(b.worldName, 'ja'),
    };
    const sorter = sorters[sortBy] || sorters.favorites;

    const categories = {};
    for (const w of worlds) {
      (categories[w.category] = categories[w.category] || []).push(w);
    }
    const catList = Object.entries(categories)
      .map(([name, list]) => ({ name, count: list.length, worlds: list.sort(sorter).slice(0, limit) }))
      .sort((a, b) => b.count - a.count);

    return {
      ok: true,
      total: worlds.length,
      categories: catList.map(c => ({ name: c.name, count: c.count })),
      worlds: catList.flatMap(c => c.worlds), // 全量展平（含分类字段），方便表格
      message: `共 ${worlds.length} 个收藏世界，分为 ${catList.length} 类`,
    };
  } catch (e) {
    return { ok: false, message: `拉取收藏失败: ${e.message}` };
  }
}

/**
 * 列出收藏分组（收藏夹名）
 */
export async function handleGetMyFavoriteGroups() {
  const { api, rateLimiter } = ctx;
  try {
    const r = await rateLimiter.execute(() => api._request('GET', '/favorite/groups'));
    if (r.status !== 200) return { ok: false, message: `favorite groups ${r.status}` };
    const groups = Array.isArray(r.data) ? r.data : [];
    const worldGroups = groups.filter(g => g.type === 'world').map(g => ({
      name: g.displayName || g.name || '',
      count: g.visibility === 'private' ? null : (g?.capacity || 0),
    }));
    return { ok: true, groups: worldGroups };
  } catch (e) {
    return { ok: false, message: `拉取收藏分组失败: ${e.message}` };
  }
}
