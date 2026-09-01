/**
 * Booth.pm (booth.pm) — VRChat 素材（avatar/服装/道具/3D 模型）检索/查询数据源
 *
 * Booth.pm 是 pixiv 旗下的数字商品平台，无公开搜索 API，但商品详情 JSON 接口
 * 匿名可访问（无需登录）：
 *   - 关键词搜索:  https://booth.pm/ja/search/<query>   (HTML, 每页约 50 个商品卡片)
 *   - 商品详情:    https://booth.pm/ja/items/{id}.json   (JSON, 含收藏数/价格/卖家/变体)
 *
 * 可获取字段: 商品名 / 价格 / 变体 / 收藏数(wish_lists_count) / 卖家(shop) /
 * 标签 / 图片 / 发布时间 / 售罄状态。
 * 注意: 下载量/销量(past_purchase_count) 匿名访问恒为 0 —— Booth 平台公开页面
 * 不展示下载量，仅卖家登录后台可见，无法抓取。
 */

import { ctx, log } from '../server-context.js';

const BASE = 'https://booth.pm';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 抓取 URL（15s 超时，浏览器 UA + 日语优先） */
async function fetchText(url) {
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

/** 抓取 JSON（Booth 商品详情接口） */
async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 从搜索页 HTML 提取商品卡片 (id / 标题 / 价格 / 图片) */
function parseSearchCards(html) {
  const cards = [];
  // Booth 搜索页同一商品有多个 <a> 链接：前几个是缩略图空链接（<a></a>），
  // 最后一个是标题链接（<a>标题文本</a>）。跳过空链接，取含文本的链接。
  const cardRe = /href="(?:https:\/\/booth\.pm)?\/ja\/items\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  const seen = new Set();
  let m;
  while ((m = cardRe.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    const block = m[2];
    // 跳过空链接块（缩略图 <a></a>），等标题链接
    // CodeQL #14: 循环移除标签直到稳定（防嵌套构造 <scr<script>ipt> 绕过一次替换），
    // 再清残留孤立尖括号（未闭合的 <script 在 innerHTML 解析中同样危险）
    let text = block;
    let prev;
    do {
      prev = text;
      text = text.replace(/<[^>]*>/g, '');
    } while (text !== prev);
    text = text.replace(/[<>]/g, '').trim();
    if (!text) continue;
    seen.add(id);
    const name = text.slice(0, 200);
    // 价格: ¥ 5,500（标题链接块内可能没有，从卡片整块取不到就留空，detail 模式会补）
    const price = block.match(/¥\s*([\d,]+)/);
    const img = block.match(/data-original="([^"]+)"/) || block.match(/src="([^"]+\.jpg[^"]*)"/);
    cards.push({
      id,
      name,
      price: price ? `¥ ${price[1]}` : null,
      imageUrl: img ? img[1] : null,
    });
    if (cards.length >= 50) break;
  }
  return cards;
}

/** 商品详情 JSON → 统一输出 */
function normalizeItem(d) {
  const shop = d.shop || {};
  return {
    id: String(d.id),
    name: d.name || '',
    price: d.price || null,
    description: (d.description || '').slice(0, 500),
    tags: (d.tags || []).map(t => t.name),
    images: (d.images || []).slice(0, 5),
    shop: {
      name: shop.name || '',
      url: shop.url || '',
    },
    publishedAt: d.published_at || null,
    isSoldOut: !!d.is_sold_out,
    isEndOfSale: !!d.is_end_of_sale,
    wishlistCount: d.wish_lists_count ?? null,
    // Booth 公开页面不展示下载量/销量：匿名访问恒为 0，仅卖家后台可见
    purchaseCount: d.past_purchase_count ?? null,
    variationCount: (d.variations || []).length,
    variations: (d.variations || []).map(v => ({
      name: v.name || '',
      price: v.price || null,
      status: v.status || '',
      hasDownloadCode: !!v.has_download_code,
    })),
    url: d.url || `https://booth.pm/ja/items/${d.id}`,
  };
}

const ITEM_FETCH_INTERVAL_MS = 400; // 串行详情查询间隔（限速，对 Booth 保持礼貌）

/** 落库旁路：失败不影响实时返回（Issue #28） */
function persistItem(item) {
  try { ctx.storage.upsertBoothItem(item); } catch (e) { log(`[booth] persist item ${item.id} failed: ${e.message}`); }
}

function persistSearch(query, items) {
  try { ctx.storage.recordBoothSearch(query, items.map(i => i.id)); } catch (e) { log(`[booth] persist search failed: ${e.message}`); }
}

/** 串行抓取多个商品详情（限速 400ms/个，单卡失败不影响整体），命中即落库 */
async function enrichItems(cards, limit) {
  const out = [];
  for (const c of cards.slice(0, limit)) {
    try {
      const d = await fetchJson(`${BASE}/ja/items/${c.id}.json`);
      const item = normalizeItem(d);
      out.push(item);
      persistItem(item);
    } catch (e) {
      log(`[booth] item ${c.id} fetch failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, ITEM_FETCH_INTERVAL_MS));
  }
  return out;
}

/** search_booth_items — 关键词搜索 Booth 商品（返回 TopN 详情，含收藏数/价格/卖家），结果落库 */
export async function handleSearchBoothItems({ query, limit = 5, detail = true }) {
  if (!query || !String(query).trim()) throw new Error('query is required');
  const n = Math.max(1, Math.min(10, Number(limit) || 5));

  const html = await fetchText(`${BASE}/ja/search/${encodeURIComponent(query)}`);
  const cards = parseSearchCards(html);
  if (cards.length === 0) return { query, results: [], total: 0 };

  if (detail === false) {
    // 只返回列表页信息（不逐个抓 .json，快），仍记录搜索历史
    const listResults = cards.slice(0, n).map(c => ({ ...c, detail: false }));
    persistSearch(query, listResults);
    return { query, total: cards.length, results: listResults };
  }

  const results = await enrichItems(cards, n);
  persistSearch(query, results);
  return { query, total: cards.length, results };
}

/** get_booth_item — 单品详情（收藏数/价格/卖家/变体/描述），命中即落库 */
export async function handleGetBoothItem({ itemId, forceRefresh = false }) {
  if (!itemId) throw new Error('itemId is required');
  const id = String(itemId).replace(/\D/g, '');
  if (!id) throw new Error('invalid itemId');

  // 缓存命中直接返回（forceRefresh 或缓存缺失才抓实时）
  if (!forceRefresh) {
    const cached = ctx.storage.getBoothItemCache(id);
    if (cached) return { ...cached, cached: true };
  }

  const d = await fetchJson(`${BASE}/ja/items/${id}.json`);
  const item = normalizeItem(d);
  persistItem(item);
  return { ...item, cached: false };
}

/** get_booth_history — 已查询过的商品快照（按收藏数/更新时间排序，趋势跟踪） */
export async function handleGetBoothHistory({ sortBy = 'wishlist', limit = 20, minWishlist = 0 } = {}) {
  const rows = ctx.storage.listBoothItems({ sortBy, limit, minWishlist });
  return { total: rows.length, items: rows };
}

/** get_booth_searches — 最近搜索历史 */
export async function handleGetBoothSearches({ limit = 10 } = {}) {
  const rows = ctx.storage.getBoothSearches({ limit });
  return { total: rows.length, searches: rows };
}
