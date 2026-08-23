const BASE = 'https://booth.pm';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

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

function parseSearchCards(html) {
  const cards = [];
  const cardRe = /href="(?:https:\/\/booth\.pm)?\/ja\/items\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  const seen = new Set();
  let m;
  while ((m = cardRe.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    const block = m[2];
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

const ITEM_FETCH_INTERVAL_MS = 400;

export default function register(api) {
  function persistItem(item) {
    try { api.consume('storage.upsertBoothItem', item); } catch (e) { api.log(`[booth] persist item ${item.id} failed: ${e.message}`); }
  }

  function persistSearch(query, items) {
    try { api.consume('storage.recordBoothSearch', query, items.map(i => i.id)); } catch (e) { api.log(`[booth] persist search failed: ${e.message}`); }
  }

  async function enrichItems(cards, limit) {
    const out = [];
    for (const c of cards.slice(0, limit)) {
      try {
        const d = await fetchJson(`${BASE}/ja/items/${c.id}.json`);
        const item = normalizeItem(d);
        out.push(item);
        persistItem(item);
      } catch (e) {
        api.log(`[booth] item ${c.id} fetch failed: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, ITEM_FETCH_INTERVAL_MS));
    }
    return out;
  }

  async function handleSearchBoothItems({ query, limit = 5, detail = true }) {
    if (!query || !String(query).trim()) throw new Error('query is required');
    const n = Math.max(1, Math.min(10, Number(limit) || 5));

    const html = await fetchText(`${BASE}/ja/search/${encodeURIComponent(query)}`);
    const cards = parseSearchCards(html);
    if (cards.length === 0) return { query, results: [], total: 0 };

    if (detail === false) {
      const listResults = cards.slice(0, n).map(c => ({ ...c, detail: false }));
      persistSearch(query, listResults);
      return { query, total: cards.length, results: listResults };
    }

    const results = await enrichItems(cards, n);
    persistSearch(query, results);
    return { query, total: cards.length, results };
  }

  async function handleGetBoothItem({ itemId, forceRefresh = false }) {
    if (!itemId) throw new Error('itemId is required');
    const id = String(itemId).replace(/\D/g, '');
    if (!id) throw new Error('invalid itemId');

    if (!forceRefresh) {
      const cached = api.consume('storage.getBoothItemCache', id);
      if (cached) return { ...cached, cached: true };
    }

    const d = await fetchJson(`${BASE}/ja/items/${id}.json`);
    const item = normalizeItem(d);
    persistItem(item);
    return { ...item, cached: false };
  }

  async function handleGetBoothHistory({ sortBy = 'wishlist', limit = 20, minWishlist = 0 } = {}) {
    const rows = api.consume('storage.listBoothItems', { sortBy, limit, minWishlist });
    return { total: rows.length, items: rows };
  }

  async function handleGetBoothSearches({ limit = 10 } = {}) {
    const rows = api.consume('storage.getBoothSearches', { limit });
    return { total: rows.length, searches: rows };
  }

  api.registerTool({
    name: 'search_booth_items',
    description: '[query·素材] Search BOOTH (booth.pm, pixiv digital-goods marketplace) for VRChat assets (avatars/clothes/3D models/accessories) by keyword. Returns items with name, price, wishlistCount (收藏数=热度), shop/seller, tags, isSoldOut, images (array of {original, resized, caption} objects — use images[0].original as the cover URL), url. NOTE: download/sales counts are NOT publicly visible on BOOTH (always 0 anonymously). Use wishlistCount as the popularity signal. Detail fetch is rate-limited to 400ms/item.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword (supports Japanese/English, e.g. avatar, VRChat, 衣装, 3Dモデル)' },
        limit: { type: 'number', default: 5, description: 'Max results (default 5, max 10)' },
        detail: { type: 'boolean', default: true, description: 'Enrich each result with detail JSON (wishlistCount/shop/tags) — rate-limited ~400ms/item; set false for fast list-only mode' },
      },
      required: ['query'],
    },
    handler: async (args) => handleSearchBoothItems(args),
  });

  api.registerTool({
    name: 'get_booth_item',
    description: '[query·素材] Get a single BOOTH item detail by item id (booth.pm/ja/items/{id}). Returns name, price, description, tags, images (array of {original, resized, caption} objects — use images[0].original as the cover URL), shop/seller, publishedAt, isSoldOut, wishlistCount (收藏数), variations, url. NOTE: purchase/download counts are not publicly visible (0 anonymously). Results are cached locally (booth_items table): cached:true returns the snapshot without hitting BOOTH; forceRefresh:true bypasses the cache.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'BOOTH item id (numeric, from item URL /ja/items/{id})' },
        forceRefresh: { type: 'boolean', default: false, description: 'Bypass local cache and fetch fresh data from BOOTH' },
      },
      required: ['itemId'],
    },
    handler: async (args) => handleGetBoothItem(args),
  });

  api.registerTool({
    name: 'get_booth_history',
    description: '[query·素材] List BOOTH items previously queried (local booth_items snapshot cache). Sorted by wishlistCount (热度) or updatedAt; supports minWishlist filter for trend tracking (which items are gaining popularity).',
    inputSchema: {
      type: 'object',
      properties: {
        sortBy: { type: 'string', default: 'wishlist', description: 'wishlist (by wishlistCount desc) | updated (by last queried)' },
        limit: { type: 'number', default: 20, description: 'Max results (1-100, default 20)' },
        minWishlist: { type: 'number', default: 0, description: 'Only items with wishlistCount >= this value' },
      },
    },
    handler: async (args) => handleGetBoothHistory(args),
  });

  api.registerTool({
    name: 'get_booth_searches',
    description: '[query·素材] List recent BOOTH search history (query, result item ids, result count, timestamp).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 10, description: 'Max results (1-50, default 10)' },
      },
    },
    handler: async (args) => handleGetBoothSearches(args),
  });
}
