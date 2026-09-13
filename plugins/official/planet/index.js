const BASE = 'https://planetvrchat.net';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const ORDERBY = {
  popular: 'custom-field.visits.desc.NUMERIC',
  new: 'custom-field.world_published.desc.DATE',
  updated: 'custom-field.world_updated.desc.DATE',
};

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#8211;/g, '–').replace(/&#8220;/g, '“').replace(/&#8221;/g, '”')
    .replace(/&#8217;/g, '’').replace(/&#8216;/g, '‘').replace(/&#8230;/g, '…')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseCards(html) {
  const cards = [];
  const articleRe = /<article\s+class="[^"]*post-(\d+)[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = articleRe.exec(html))) {
    const postId = m[1];
    const block = m[2];
    const link = block.match(/href="https:\/\/planetvrchat\.net\/archives\/\d+"/);
    const title = block.match(/rel="bookmark"\s+title="([^"]*)"\s+class="post-list__link"/) ||
      block.match(/class="h2 entry-title">([^<]*)</);
    if (!link || !title) continue;
    const platform = block.match(/pvrc-world-platform-badge"[^>]*aria-label="([^"]*)"/);
    const cats = [...block.matchAll(/archive-taxonomy-chip--category">([^<]*)<\/span>/g)].map((x) => x[1]);
    const tagsBlock = block.match(/<\/span>\s*([^<]+)\s*<\/small>/);
    const tags = tagsBlock ? tagsBlock[1].trim().split(/\s+/).filter(Boolean) : [];
    const img = block.match(/src="([^"]*thumb[^"]*\.(?:webp|png|jpg))"/);
    cards.push({
      postId,
      name: decodeEntities(title[1] || title[2] || '').trim(),
      url: link[0].replace(/href="|"$/g, ''),
      platform: platform ? decodeEntities(platform[1]) : '',
      categories: cats.map((c) => decodeEntities(c)),
      tags: tags.map((t) => decodeEntities(t)).slice(0, 8),
      image: img ? img[1] : '',
      wrldId: null,
      maxPlayers: null,
      visitors: null,
      favorites: null,
      publishedAt: null,
    });
  }
  return cards;
}

function parseDetail(html) {
  const d = {};
  const wid = html.match(/wrld_[a-f0-9-]{36}/);
  if (wid) d.wrldId = wid[0];
  const maxP = html.match(/最大人数(?:<[^>]+>\s*)*([\d,]+)\s*人/);
  if (maxP) d.maxPlayers = parseInt(maxP[1].replace(/,/g, ''), 10);
  const vis = html.match(/総訪問者(?:<[^>]+>\s*)*([\d,]+)/);
  if (vis) d.visitors = parseInt(vis[1].replace(/,/g, ''), 10);
  const fav = html.match(/⭐\s*(?:<[^>]+>\s*)*お気に入り(?:<[^>]+>\s*)*([\d,]+)/);
  if (fav) d.favorites = parseInt(fav[1].replace(/,/g, ''), 10);
  const pub = html.match(/公開日(?:<[^>]+>\s*)*(\d{4}-\d{2}-\d{2})/);
  if (pub) d.publishedAt = pub[1];
  return d;
}

async function enrich(cards, limit, log, ext) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 8);
  for (const c of cards.slice(0, n)) {
    const startedAt = Date.now();
    try {
      const html = await fetchHtml(c.url);
      Object.assign(c, parseDetail(html));
      // 成功 → debug（>2000ms 自动升 INFO）
      ext?.success?.('PlanetVRC', `抓取详情 post ${c.postId}`, { durationMs: Date.now() - startedAt });
    } catch (e) {
      // 失败留痕（WARN + ops_log）：详情抓不到时保留列表项（部分降级，不阻断整体搜索）
      if (ext?.failure) ext.failure('PlanetVRC', `抓取详情 post ${c.postId}`, e, { durationMs: Date.now() - startedAt });
      else log(`PlanetVRC 详情失败 ${c.postId}: ${e.message}`);
    }
  }
  return cards;
}

async function fetchCards(queryParams, limit, log, ext) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 8);
  const qs = new URLSearchParams({ s: '', vkfs_submitted: '1', ...queryParams }).toString();
  const startedAt = Date.now();
  let html;
  try {
    html = await fetchHtml(`${BASE}/?${qs}`);
  } catch (e) {
    if (ext?.failure) ext.failure('PlanetVRC', '抓取排行列表', e, { durationMs: Date.now() - startedAt });
    throw e;
  }
  ext?.success?.('PlanetVRC', '抓取排行列表', { durationMs: Date.now() - startedAt });
  const cards = parseCards(html);
  if (!cards.length) {
    // 降级留痕：远端可达但解析为空 → 视为该源无结果（调用方据此跳过该源）
    if (ext?.fallback) ext.fallback('PlanetVRC', '抓取排行列表', '页面解析为空（该源无结果，跳过）');
    throw new Error('PlanetVRC 无结果');
  }
  await enrich(cards, n, log, ext);
  return cards.slice(0, n);
}

export default function register(api) {
  async function handleSearchPlanetWorlds({ query, limit = 5 }) {
    const q = String(query || '').trim();
    if (!q) throw new Error('query is required');
    api.log(`PlanetVRC 搜索: ${q}`);
    const cards = await fetchCards({ s: q }, limit, api.log, api.extLog);
    return {
      source: 'planetvrchat.net',
      query: q,
      count: cards.length,
      worlds: cards,
    };
  }

  async function handleRecommendPlanetWorlds({ sort = 'popular', limit = 5 }) {
    const key = ORDERBY[sort] ? sort : 'popular';
    api.log(`PlanetVRC 推荐: ${key}`);
    const cards = await fetchCards({ vkfs_orderby: ORDERBY[key] }, limit, api.log, api.extLog);
    return {
      source: 'planetvrchat.net',
      sort: key,
      count: cards.length,
      worlds: cards,
    };
  }

  api.registerTool({
    name: 'search_planet_worlds',
    description: '[query·地图] Search VRChat worlds on PlanetVRC (planetvrchat.net, Japanese world directory) by keyword. Returns world name, wrld_id (when enriched), platform, categories, favorites/visitors counts. Useful for finding worlds by Japanese/English keywords that the VRChat API search may miss.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword (supports Japanese/English)' },
        limit: { type: 'number', default: 5, description: 'Max results (default 5, max 8; each result fetches its detail page for wrld_id/stats)' },
      },
      required: ['query'],
    },
    handler: async (args) => handleSearchPlanetWorlds(args),
  });

  api.registerTool({
    name: 'recommend_planet_worlds',
    description: '[query·推荐] PlanetVRC world rankings (planetvrchat.net): popular (most visited), new (recently published), or updated. Returns worlds with wrld_id, maxPlayers, visitors, favorites, publishedAt.',
    inputSchema: {
      type: 'object',
      properties: {
        sort: { type: 'string', default: 'popular', description: 'popular | new | updated' },
        limit: { type: 'number', default: 5, description: 'Max results (default 5, max 8)' },
      },
    },
    handler: async (args) => handleRecommendPlanetWorlds(args),
  });
}
