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
 * @param {Object} args { days: 1|7|30, refresh: bool }
 */
export async function handleWorldAnalytics({ days = 7, refresh = true } = {}) {
  const { api, rateLimiter, storage } = ctx;
  const d = Math.max(1, Math.min(parseInt(days, 10) || 7, 30));
  const limit = LIMITS[d] || 50;
  const since = new Date(Date.now() - d * DAY_MS);
  const sinceDate = since.toISOString().slice(0, 10);
  const scanDate = new Date().toISOString().slice(0, 10);

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
 * 查询分析结果
 * @param {Object} args { days, sortBy, category, limit }
 */
export async function handleSiteWorlds({ days = 7, sortBy = 'favorites_ratio', category = '', limit = 20 } = {}) {
  const { storage } = ctx;
  const d = Math.max(1, Math.min(parseInt(days, 10) || 7, 30));
  const sinceDate = new Date(Date.now() - d * DAY_MS).toISOString().slice(0, 10);
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));

  const rows = storage.getSiteWorlds({
    sinceDate,
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
    category: r.category,
  }));

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
