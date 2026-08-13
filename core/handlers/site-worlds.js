/**
 * 世界推荐网站分析 handler — world_analytics / site_worlds / site_world_trends / site_world_categories
 *
 * 数据源：PlanetVRC (planetvrchat.net) + vrclist.com + VRChat API
 * 能力：新世界收藏比排行、趋势分析、类型过滤、日/周/月排行、简介 + 图片
 */

import { ctx, log } from '../server-context.js';
import {
  fetchPlanetVRC,
  searchVrclist,
  rankWorlds,
  favoriteRatio,
  trendAnalysis,
} from '../fetch-site-worlds.js';
import { fetchWorldStats } from '../fetch-x-worlds.js';

const DAY_MS = 86400000;
// 推荐上限：日10 / 周50 / 月100
const LIMITS = { 1: 10, 7: 50, 30: 100 };

/**
 * 扫描指定时间窗口的世界推荐网站，聚合 VRChat 数据入库
 * @param {Object} args { days: 1|7|30, refresh: bool, mode: 'site'|'new' }
 *   mode='site' 默认：PlanetVRC 收录（可能含老图重传）
 *   mode='new'：直接按 VRChat created_at 排序拉最新发布的世界（真正的"新图"）
 */
export async function handleWorldAnalytics({ days = 7, refresh = true, mode = 'site' } = {}) {
  const { api, rateLimiter, storage } = ctx;
  const d = Math.max(1, Math.min(parseInt(days, 10) || 7, 30));
  const limit = LIMITS[d] || 50;
  const since = new Date(Date.now() - d * DAY_MS);
  const sinceDate = since.toISOString().slice(0, 10);
  const scanDate = new Date().toISOString().slice(0, 10);

  if (mode === 'new') {
    return await scanNewVRChatWorlds({ api, rateLimiter, storage, days: d, limit, scanDate, since });
  }

  // 1) PlanetVRC 拉世界列表（上限内）
  let planets = [];
  try {
    planets = await fetchPlanetVRC(since, limit);
    log?.('info', `[world_analytics] PlanetVRC 拉到 ${planets.length} 个世界（${d}天窗口）`);
  } catch (e) {
    log?.('warn', `[world_analytics] PlanetVRC 抓取失败: ${e.message}`);
  }

  // 2) vrclist 搜索补充缩略图（按世界名模糊匹配）
  let vrclistMap = new Map();
  try {
    const vlist = await searchVrclist('');
    for (const v of vlist) {
      if (v.name && !vrclistMap.has(v.name)) vrclistMap.set(v.name, v);
    }
  } catch (e) {
    log?.('warn', `[world_analytics] vrclist 抓取失败: ${e.message}`);
  }

  // 3) 逐个查 VRChat 详情（收藏/浏览/描述/作者）
  let saved = 0;
  let failed = 0;
  for (const p of planets) {
    try {
      // VRChat 详情（已有 rate limit）
      const stats = await fetchWorldStats(api, rateLimiter, { worldId: p.worldId });
      if (!stats) { failed++; continue; }
      // vrclist 缩略图补充
      const vmatch = vrclistMap.get(stats.worldName || p.name) || vrclistMap.get(p.name);
      const imageUrl = vmatch?.thumbnail || stats.imageUrl || '';
      storage.upsertSiteWorld({
        worldId: p.worldId,
        worldName: stats.worldName || p.name,
        authorName: stats.authorName || '',
        description: stats.description || '',
        imageUrl,
        favorites: stats.favorites || 0,
        visits: stats.visits || 0,
        popularity: stats.popularity || 0,
        capacity: stats.capacity || 0,
        tags: JSON.stringify(stats.tags || []),
        source: 'planetvrchat',
        sourceId: p.sourceId,
        sourceUrl: p.sourceUrl,
        sourceDate: p.date,
        category: p.category || '',
        createdAt: stats.createdAt || '',
      });
      // 扫描快照（用于趋势）
      storage.logSiteScan({
        scanDate, source: 'planetvrchat', worldId: p.worldId,
        worldName: stats.worldName || p.name,
        favorites: stats.favorites || 0, visits: stats.visits || 0, popularity: stats.popularity || 0,
      });
      saved++;
    } catch (e) {
      failed++;
      log?.('warn', `[world_analytics] ${p.name} 查询失败: ${e.message}`);
    }
  }

  return {
    ok: true,
    windowDays: d,
    limit,
    fetched: planets.length,
    saved,
    failed,
    scanDate,
    message: `已扫描 ${d} 天窗口（上限 ${limit} 个），成功收录 ${saved} 个世界`,
  };
}

/**
 * 模式 'new'：直接按 VRChat created_at 排序拉最新发布的世界
 * VRChat API: /worlds?sort=created&n=100 返回按创建时间倒序的世界（需服务认证）
 * 过滤创建时间在窗口内的，查详情入库
 */
async function scanNewVRChatWorlds({ api, rateLimiter, storage, days, limit, scanDate, since }) {
  let saved = 0;
  let failed = 0;
  let skipped = 0;
  const sinceIso = since.toISOString();
  const candidates = []; // 窗口内所有世界（先只收集列表数据，不查详情）
  try {
    // 翻页收集窗口内全部新世界（列表接口含 favorites/visits 但可能不全，详情后再补）
    const perPage = 100;
    let offset = 0;
    let reachedWindowStart = false;
    while (!reachedWindowStart) {
      const r = await rateLimiter.execute(() => api._request('GET', `/worlds?sort=created&n=${perPage}&offset=${offset}`));
      if (r.status !== 200 || !Array.isArray(r.data) || r.data.length === 0) {
        if (r.status !== 200) {
          return { ok: false, message: `VRChat API 返回 ${r.status}，无法拉取新世界`, saved: 0, failed: 0 };
        }
        break;
      }
      // [debug] 分页诊断
      const pDates = r.data.map(w => w.created_at ? w.created_at.slice(0, 10) : '?');
      log?.('info', `[world_analytics] 页${offset / perPage + 1}: ${r.data.length}个 日期范围 ${pDates[pDates.length - 1]} → ${pDates[0]}`);

      for (const w of r.data) {
        if (!w.created_at) continue;
        if (w.created_at < sinceIso) { reachedWindowStart = true; break; }
        candidates.push({
          id: w.id, name: w.name || '', authorName: w.authorName || '',
          favorites: w.favorites || 0, visits: w.visits || 0,
          createdAt: w.created_at, description: w.description || '',
          imageUrl: w.imageUrl || '', tags: Array.isArray(w.tags) ? w.tags : [],
        });
      }
      offset += perPage;
      if (offset >= 3000) break; // 安全阀 30 页
    }

    // 全部候选入库（列表数据，收藏比暂用列表的 favorites/visits）
    for (const w of candidates) {
      try {
        storage.upsertSiteWorld({
          worldId: w.id,
          worldName: w.name,
          authorName: w.authorName || '',
          description: w.description || '',
          imageUrl: w.imageUrl || '',
          favorites: w.favorites || 0,
          visits: w.visits || 0,
          popularity: 0,
          capacity: 0,
          tags: JSON.stringify(w.tags || []),
          source: 'vrchat-new',
          sourceId: '',
          sourceUrl: '',
          sourceDate: (w.createdAt || '').slice(0, 10),
          category: '',
          createdAt: w.createdAt || '',
        });
      } catch { /* 单条失败忽略 */ }
    }

    // 对收藏≥50 的查详情补全（收藏比准确）
    const qualified = candidates.filter(w => w.favorites >= 50);
    log?.('info', `[world_analytics] 窗口内新图 ${candidates.length} 个，收藏≥50 的 ${qualified.length} 个（补详情）`);

    for (const w of qualified.slice(0, limit)) {
      try {
        // 详情（补全 visits/收藏比数据）
        const stats = await fetchWorldStats(api, rateLimiter, { worldId: w.id });
        if (!stats) { failed++; continue; }
        storage.upsertSiteWorld({
          worldId: w.id,
          worldName: stats.worldName || w.name || '',
          authorName: stats.authorName || w.authorName || '',
          description: stats.description || w.description || '',
          imageUrl: stats.imageUrl || w.imageUrl || '',
          favorites: stats.favorites || w.favorites || 0,
          visits: stats.visits || w.visits || 0,
          popularity: stats.popularity || 0,
          capacity: stats.capacity || 0,
          tags: JSON.stringify(stats.tags || w.tags || []),
          source: 'vrchat-new',
          sourceId: '',
          sourceUrl: '',
          sourceDate: (stats.createdAt || w.createdAt || '').slice(0, 10),
          category: '',
          createdAt: stats.createdAt || w.createdAt || '',
        });
        storage.logSiteScan({
          scanDate, source: 'vrchat-new', worldId: w.id,
          worldName: stats.worldName || w.name,
          favorites: stats.favorites || w.favorites || 0, visits: stats.visits || w.visits || 0, popularity: stats.popularity || 0,
        });
        saved++;
      } catch (e) {
        failed++;
      }
    }
    skipped = candidates.length - qualified.length;
  } catch (e) {
    return { ok: false, message: `新世界扫描失败: ${e.message}`, saved, failed };
  }

  return {
    ok: true,
    windowDays: days,
    limit,
    mode: 'new',
    fetched: candidates.length,
    saved,
    failed,
    skipped, // 收藏<50 未查详情的
    scanDate,
    message: `已分页扫描近 ${days} 天：窗口内新图 ${candidates.length} 个，收藏≥50 的 ${saved} 个入库`,
  };
}

/**
 * 查询分析结果
 * @param {Object} args { days, sortBy, category, limit }
 */
export async function handleSiteWorlds({ days = 7, sortBy = 'favorites_ratio', category = '', limit = 20, newOnly = false, excludeAvatar = true, minFavorites = 50 } = {}) {
  const { storage } = ctx;
  const d = Math.max(1, Math.min(parseInt(days, 10) || 7, 30));
  const sinceDate = new Date(Date.now() - d * DAY_MS).toISOString().slice(0, 10);
  const sinceCreatedAt = new Date(Date.now() - d * DAY_MS).toISOString();
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));
  const minFav = Math.max(0, parseInt(minFavorites, 10) || 50);

  const rows = storage.getSiteWorlds({
    sinceDate,
    // newOnly=true 时按 VRChat 真实创建时间过滤（排除老图重传）
    sinceCreatedAt: newOnly ? sinceCreatedAt : undefined,
    category: category || undefined,
    sortBy: 'favorites', // 先按收藏取全量，再在内存里按收藏比排序（favorites_ratio 需要精确计算）
    limit: Math.max(lim * 3, 100),
  });

  let worlds = rows.map(r => ({
    worldId: r.world_id,
    worldName: r.world_name,
    authorName: r.author_name,
    description: r.description,
    imageUrl: r.image_url,
    favorites: r.favorites,
    visits: r.visits,
    popularity: r.popularity,
    capacity: r.capacity,
    favoriteRatio: favoriteRatio(r.favorites, r.visits),
    source: r.source,
    sourceUrl: r.source_url,
    sourceDate: r.source_date,
    createdAt: r.created_at || '',
    category: r.category,
  }));

  // 过滤：收藏数下限（默认 ≥50，去除样本过小的新图/测试图）
  worlds = worlds.filter(w => w.favorites >= minFav);

  // 过滤：排除 Avatar 世界（名称含 avatar world / 模型展示店等）
  if (excludeAvatar) {
    const avatarRe = /avatar\s*world|アバター|改模|模型|展示|avatar/i;
    worlds = worlds.filter(w => !avatarRe.test(w.worldName) && !avatarRe.test(w.authorName || ''));
  }

  // 排序
  const sorters = {
    favorites_ratio: (a, b) => b.favoriteRatio - a.favoriteRatio,
    favorites: (a, b) => b.favorites - a.favorites,
    visits: (a, b) => b.visits - a.visits,
    popularity: (a, b) => b.popularity - a.popularity,
  };
  worlds.sort(sorters[sortBy] || sorters.favorites_ratio);
  worlds = worlds.slice(0, lim);

  return {
    ok: true,
    windowDays: d,
    sortBy,
    category: category || 'all',
    newOnly: !!newOnly,
    excludeAvatar: !!excludeAvatar,
    minFavorites: minFav,
    total: worlds.length,
    highlightedCount: worlds.filter(w => w.favoriteRatio >= 0.2).length,
    worlds,
  };
}

/**
 * 趋势分析：扫描历史中收藏/浏览增长最快的世界
 * @param {Object} args { days, top }
 */
export async function handleSiteWorldTrends({ days = 7, top = 10 } = {}) {
  const { storage } = ctx;
  const scanDates = storage.getSiteScanDates(60).map(r => r.scan_date);
  if (scanDates.length < 2) {
    return { ok: true, message: '扫描历史不足（至少需要两次扫描），请先运行 world_analytics 抓取', trends: [] };
  }

  // 对每个世界计算趋势
  const trends = [];
  const sinceDate = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const rows = storage.getSiteWorlds({ sinceDate, sortBy: 'favorites', limit: 200 });
  for (const r of rows) {
    const history = storage.getSiteWorldHistory(r.world_id);
    if (history.length >= 2) {
      const t = trendAnalysis(history);
      if (t && t.favoritesDelta > 0) {
        trends.push({
          worldId: r.world_id,
          worldName: r.world_name,
          authorName: r.author_name,
          favorites: r.favorites,
          visits: r.visits,
          favoriteRatio: favoriteRatio(r.favorites, r.visits),
          imageUrl: r.image_url,
          favoritesDelta: t.favoritesDelta,
          visitsDelta: t.visitsDelta,
          favoritesGrowthPct: t.favoritesGrowthPct,
          daysSpan: t.daysSpan,
        });
      }
    }
  }
  trends.sort((a, b) => (b.favoritesGrowthPct || 0) - (a.favoritesGrowthPct || 0));
  const t = trends.slice(0, Math.max(1, Math.min(parseInt(top, 10) || 10, 50)));

  return { ok: true, windowDays: days, total: t.length, trends: t };
}

/**
 * 列出可用分类（type 过滤用）
 */
export async function handleSiteWorldCategories() {
  const { storage } = ctx;
  const rows = storage.getSiteWorlds({ sortBy: 'favorites', limit: 300 });
  const catCount = {};
  for (const r of rows) {
    const c = r.category || 'other';
    catCount[c] = (catCount[c] || 0) + 1;
  }
  return { ok: true, categories: Object.entries(catCount).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) };
}

export async function handleSiteWorldStats() {
  const { storage } = ctx;
  const total = storage.getSiteWorlds({ sortBy: 'favorites', limit: 1000 }).length;
  const scanDates = storage.getSiteScanDates(10).map(r => r.scan_date);
  return { ok: true, totalWorlds: total, recentScans: scanDates };
}
