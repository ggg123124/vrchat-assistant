/**
 * 世界推荐网站抓取分析模块（world_analytics 工具的数据源）
 *
 * 数据流：
 *   1. PlanetVRC (planetvrchat.net) WordPress REST API
 *      - GET /wp-json/wp/v2/posts?after=YYYY-MM-DD&per_page=100
 *      - 每个世界是一个帖子，slug 形如 vrc-world-wrld_xxxxxxxx-xxxx-...
 *      - 分类：upload_date（上传日期）、wauthor（作者）、quest（Quest 适配）、feature_tag（特集）
 *   2. vrclist.com POST /worlds/search-light
 *      - 免费 API，返回 { id, name, thumbnailImageUrl }
 *      - 用于补充世界缩略图
 *   3. VRChat API（复用 fetch-x-worlds.js 的 fetchWorldStats）
 *      - 补全 favorites / visits（收藏比）/ popularity / description / capacity
 *
 * 用途：新世界收藏比排行、站内新趋势分析、类型过滤分析、日/周/月排行
 */

import { fetchWorldStats } from './fetch-x-worlds.js';
import { log } from './server-context.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PLANET_API = 'https://planetvrchat.net/wp-json/wp/v2';
const VRCLIST_API = 'https://api.vrclist.com';

// ── 基础 HTTP 工具 ───────────────────────────────────────────

async function httpGet(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res;
}

async function httpPost(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res;
}

// ── PlanetVRC 抓取 ──────────────────────────────────────────

/**
 * 批量拉取 PlanetVRC 术语（分类 ID → 名称），用于类型解析
 * @param {string} taxonomy quest | feature_tag | wauthor 等
 */
export async function fetchPlanetTermsMap(taxonomy) {
  const map = {};
  try {
    const res = await httpGet(`${PLANET_API}/${taxonomy}?per_page=100`);
    const terms = await res.json();
    if (Array.isArray(terms)) {
      for (const t of terms) {
        if (t?.id && t?.name) map[t.id] = t.name;
      }
    }
  } catch (e) {
    log?.('warn', `[fetch-site-worlds] ${taxonomy} 术语拉取失败: ${e.message}`);
  }
  return map;
}

/**
 * 从 PlanetVRC 拉取指定日期后的世界帖子
 * @param {Date} since 起始日期
 * @param {number} max 最大条数（日10/周50/月100）
 * @returns {Promise<Array>} [{ worldId, name, sourceId, sourceUrl, date, category, authorTerm }]
 */
export async function fetchPlanetVRC(since, max = 50) {
  const sinceStr = since.toISOString().slice(0, 10) + 'T00:00:00';
  // 预拉术语映射（类型 + Quest 适配）
  const [questMap, featureMap] = await Promise.all([
    fetchPlanetTermsMap('quest'),
    fetchPlanetTermsMap('feature_tag'),
  ]);
  const results = [];
  let page = 1;
  while (results.length < max) {
    const url = `${PLANET_API}/posts?after=${encodeURIComponent(sinceStr)}&per_page=100&page=${page}&_fields=id,date,slug,title,link,wauthor,quest,feature_tag`;
    const res = await httpGet(url);
    const posts = await res.json();
    if (!Array.isArray(posts) || posts.length === 0) break;
    for (const p of posts) {
      // 只收世界帖子（slug 含 wrld_ 或 vrc-world- 前缀）
      const m = (p.slug || '').match(/wrld_[0-9a-f-]+/i);
      if (!m) continue;
      // 类型解析：feature_tag（特集标签，如 ホラー/景観/ゲーム）优先，quest（Quest対応）补充
      const featNames = (p.feature_tag || []).map(id => questMap[id] || featureMap[id] || '').filter(Boolean);
      const questNames = (p.quest || []).map(id => questMap[id] || '').filter(Boolean);
      const category = featNames.join('+') || questNames.join('+') || '';
      results.push({
        worldId: m[0],
        name: (p.title?.rendered || '').trim(),
        sourceId: String(p.id || ''),
        sourceUrl: p.link || '',
        date: p.date || '',
        category,
      });
      if (results.length >= max) break;
    }
    // 分页结束
    const totalPages = Number(res.headers.get('x-wp-totalpages') || '1');
    if (page >= totalPages) break;
    page++;
    // 节流，避免打爆
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

/**
 * 解析 PlanetVRC 分类名（upload_date / wauthor / quest / feature_tag）
 * @param {string} taxonomy 分类法名
 * @param {Array<number>} termIds 分类 ID 数组
 */
export async function fetchPlanetTerms(taxonomy, termIds) {
  const names = [];
  for (const id of termIds) {
    try {
      const res = await httpGet(`${PLANET_API}/${taxonomy}/${id}`);
      const t = await res.json();
      if (t?.name) names.push(t.name);
    } catch { /* 单条失败忽略 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return names;
}

// ── vrclist 抓取 ────────────────────────────────────────────

/**
 * 用 vrclist search-light 搜索世界（返回 id + name + 缩略图）
 * @param {string} query 关键词（空=最近）
 */
export async function searchVrclist(query = '') {
  const res = await httpPost(`${VRCLIST_API}/worlds/search-light`, { search_query: query });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(w => ({
    id: w.id,
    name: w.name || '',
    thumbnail: w.thumbnailImageUrl || '',
  }));
}

// ── 数据分析 ─────────────────────────────────────────────────

/**
 * 计算收藏/浏览比（favorites / visits）
 */
export function favoriteRatio(favorites, visits) {
  if (!visits || visits <= 0) return 0;
  return favorites / visits;
}

/**
 * 分析排行：按收藏比/收藏数/浏览数排序
 * @param {Array} worlds 世界列表（含 favorites/visits）
 * @param {string} sortBy favorites_ratio | favorites | visits | popularity
 */
export function rankWorlds(worlds, sortBy = 'favorites_ratio') {
  const list = worlds.map(w => ({
    ...w,
    favoriteRatio: favoriteRatio(w.favorites, w.visits),
  }));
  const sorters = {
    favorites_ratio: (a, b) => b.favoriteRatio - a.favoriteRatio,
    favorites: (a, b) => b.favorites - a.favorites,
    visits: (a, b) => b.visits - a.visits,
    popularity: (a, b) => b.popularity - a.popularity,
  };
  const sorter = sorters[sortBy] || sorters.favorites_ratio;
  return list.sort(sorter);
}

/**
 * 趋势分析：对比最近两次扫描的收藏/浏览增长
 * @param {Array} history 该世界的扫描历史（按时间升序）
 */
export function trendAnalysis(history) {
  if (!history || history.length < 2) return null;
  const prev = history[history.length - 2];
  const curr = history[history.length - 1];
  return {
    favoritesDelta: curr.favorites - prev.favorites,
    visitsDelta: curr.visits - prev.visits,
    favoritesGrowthPct: prev.favorites > 0 ? ((curr.favorites - prev.favorites) / prev.favorites) * 100 : null,
    daysSpan: ((new Date(curr.scan_date) - new Date(prev.scan_date)) / 86400000).toFixed(1),
  };
}
