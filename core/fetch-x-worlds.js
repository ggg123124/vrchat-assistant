/**
 * X 博主世界推荐抓取模块（x_world_digest 工具的数据源）
 *
 * 数据流：
 *   1. 从 config 表读取博主清单（key='x_creators'，JSON 数组）
 *   2. 逐个抓取 Nitter RSS（https://nitter.net/{user}/rss，免费匿名，无需 X API）
 *   3. 解析推文：时间、文本、世界链接（vrchat.com/home/world/wrld_xxx）
 *   4. 从推文文本提取世界名（"World: XXX" / "ワールド名: XXX" 模式）→ VRChat API 搜索兜底
 *   5. 查询世界详情（favorites / visits / popularity）→ 写入 x_world_recommendations 表
 *
 * 用途：x_world_digest MCP 工具按 1/3/7/15/30 天窗口聚合博主推荐，按收藏排序输出。
 */

import { ctx, log } from './server-context.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';

// Nitter 实例列表（按实测可达性排序：nitter.net 本机实测可用，其余为回退）
const NITTER_INSTANCES = [
  'https://nitter.net',
  'https://nitter.tiekoetter.com',
  'https://nitter.poast.org',
  'https://xcancel.com',
  'https://nitter.privacydev.net',
  'https://nitter.1d4.us',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const NITTER_TIMEOUT_MS = 12000;   // 单实例超时（短，便于快速回退）
const NITTER_MIN_BYTES = 200;      // 空壳检测：响应体小于此字节视为不可用
const MAX_TWEETS_PER_CREATOR = 20; // Nitter RSS 固定返回最近 ~20 条

// ── X SearchTimeline GraphQL 兜底数据源 ─────────────────────
// 背景：Nitter 实例不稳定（403/404/SSL 挂/部分博主无缓存），且 RSS 仅返回最近 ~20 条，
// 导致高频博主（如 Bradlee1011）3 天 10+ 条推荐只抓到 3 条。X 的 SearchTimeline GraphQL
// 用 guest token 可拉取完整推文流（product=Latest，count=20 可翻页），作为 Nitter 失败时的兜底。
// 注：X API 同样会限流/轮换 queryId，故只作降级兜底，不替代 Nitter。
const X_BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
// SearchTimeline queryId 会被 X 定期轮换，故支持环境变量覆盖（无需改代码）
const X_SEARCH_QUERY_ID = process.env.VRC_MONITOR_X_SEARCH_QUERY_ID || 'hyPfJYJ_XAtDYoslQc-Rgg';
const X_SEARCH_FEATURES = {
  'rweb_tipjar_consumption_enabled': true,
  'responsive_web_graphql_exclude_directive_enabled': true,
  'verified_phone_label_enabled': false,
  'creator_subscriptions_tweet_preview_api_enabled': true,
  'responsive_web_graphql_timeline_navigation_enabled': true,
  'responsive_web_graphql_skip_user_profile_image_extensions_enabled': false,
  'c9s_tweet_anatomy_moderator_badge_enabled': true,
  'tweetypie_unmention_optimization_enabled': true,
  'responsive_web_edit_tweet_api_enabled': true,
  'graphql_is_translatable_rweb_tweet_is_translatable_enabled': true,
  'view_counts_everywhere_api_enabled': true,
  'longform_notetweets_consumption_enabled': true,
  'responsive_web_twitter_article_tweet_consumption_enabled': false,
  'tweet_awards_web_tipping_enabled': false,
  'freedom_of_speech_not_reach_fetch_enabled': true,
  'standardized_nudges_misinfo': true,
  'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled': true,
  'rweb_video_timestamps_enabled': true,
  'longform_notetweets_rich_text_read_enabled': true,
  'responsive_web_enhance_cards_enabled': false,
};
const X_GUEST_TOKEN_TTL_MS = 3 * 3600 * 1000; // guest token 缓存 3 小时
let _xGuestToken = null;
let _xGuestTokenAt = 0;

/**
 * 代理解析：默认【直连】（不设代理）。
 * 仅当显式设置 VRC_MONITOR_HTTP_PROXY / HTTPS_PROXY / HTTP_PROXY 时才走代理，
 * 避免默认写死 7892 导致未开代理时全失败。
 */
function resolveProxy() {
  const env = process.env;
  return env.VRC_MONITOR_HTTP_PROXY || env.HTTPS_PROXY || env.https_proxy
    || env.HTTP_PROXY || env.http_proxy || '';
}

/**
 * 基于 node:http(s) 的请求（与 ws-manager.js 同方案，agent 字段对原生 fetch 无效）。
 * 代理策略：显式配置代理 → 走 HttpsProxyAgent；否则直连。
 * 返回 { status, headers, body }。
 */
function httpRequest(url, { headers = {}, timeoutMs = NITTER_TIMEOUT_MS, agent = null, method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:');
    const lib = isHttps ? https : http;
    const opts = { headers, method };
    if (agent) opts.agent = agent;
    const req = lib.request(url, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // 手动解压（node:https 不像 fetch 自动处理 content-encoding）
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let body;
        if (enc === 'gzip' || enc === 'x-gzip') {
          try { body = zlib.gunzipSync(buf).toString('utf-8'); }
          catch { body = buf.toString('utf-8'); }
        } else if (enc === 'deflate') {
          try { body = zlib.inflateSync(buf).toString('utf-8'); }
          catch { body = buf.toString('utf-8'); }
        } else {
          body = buf.toString('utf-8');
        }
        resolve({ status: res.statusCode || 0, headers: res.headers || {}, body });
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

/** 尝试一次请求：有代理先走代理，失败（ECONNREFUSED/超时等）则回退直连 */
async function tryFetchOnce(url) {
  const proxy = resolveProxy();
  const errors = [];
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Encoding': 'gzip, deflate',
  };
  if (proxy) {
    try {
      const agent = new HttpsProxyAgent(proxy);
      return await httpRequest(url, { headers, agent });
    } catch (e) {
      errors.push(`代理(${proxy})失败: ${e.code || e.message}`);
    }
  }
  // 直连（无代理配置，或代理失败回退）
  try {
    return await httpRequest(url, { headers });
  } catch (e) {
    errors.push(`直连失败: ${e.code || e.message}`);
  }
  const err = new Error(errors.join('；'));
  err.code = 'FETCH_FAILED';
  throw err;
}

/**
 * 抓取某博主的 Nitter RSS，返回推文数组：
 * [{ id, url, time (ISO), text, worldIds: [], worldNames: [] }]
 *
 * 多实例回退：依次尝试 NITTER_INSTANCES（每个实例先代理后直连），
 * 任一实例返回非空 RSS 即成功；全部失败时抛 NITTER_UNREACHABLE（含诊断）。
 */
export async function fetchCreatorRss(screenName) {
  const errors = [];
  for (const base of NITTER_INSTANCES) {
    const url = `${base}/${encodeURIComponent(screenName)}/rss`;
    try {
      const resp = await tryFetchOnce(url);
      if (!resp.status || resp.status >= 400) {
        errors.push(`${base} → HTTP ${resp.status}`);
        continue;
      }
      const xml = resp.body || '';
      // 空壳检测：内容过短视为不可用（实测部分实例返回 200 但 0 字节）
      if (xml.length < NITTER_MIN_BYTES || !xml.includes('<rss')) {
        errors.push(`${base} → 空响应(${xml.length}B)`);
        continue;
      }
      const tweets = parseRss(xml, screenName);
      if (tweets.length === 0) {
        errors.push(`${base} → RSS 无推文条目`);
        continue;
      }
      return tweets; // 首个可用实例
    } catch (e) {
      errors.push(`${base} → ${e.code || e.message.slice(0, 60)}`);
    }
  }
  // 全部失败：结构化错误（供 handler 转成用户可读提示）
  const err = new Error(`Nitter 全部实例不可达（@${screenName}）：${errors.join('；')}。可尝试设置 HTTPS_PROXY 或更换网络。`);
  err.code = 'NITTER_UNREACHABLE';
  err.details = errors;
  throw err;
}

// ── X SearchTimeline 兜底 ──────────────────────────────────

/**
 * 激活并缓存 X guest token（公开匿名 token，用于 SearchTimeline GraphQL）。
 * 缓存 3 小时，避免每次抓取都重新激活。
 */
async function getXGuestToken() {
  const now = Date.now();
  if (_xGuestToken && now - _xGuestTokenAt < X_GUEST_TOKEN_TTL_MS) return _xGuestToken;
  const resp = await httpRequest('https://api.twitter.com/1.1/guest/activate.json', {
    headers: { 'User-Agent': UA, 'Authorization': `Bearer ${X_BEARER_TOKEN}`, 'Content-Type': 'application/json' },
    timeoutMs: 15000,
    method: 'POST',
  });
  if (resp.status !== 200) {
    const e = new Error(`X guest token 激活失败：HTTP ${resp.status}`);
    e.code = 'X_GUEST_ACTIVATE_FAILED';
    throw e;
  }
  const data = JSON.parse(resp.body);
  if (!data.guest_token) {
    const e = new Error('X guest token 响应缺少 guest_token 字段');
    e.code = 'X_GUEST_ACTIVATE_FAILED';
    throw e;
  }
  _xGuestToken = data.guest_token;
  _xGuestTokenAt = now;
  return _xGuestToken;
}

/**
 * 从 SearchTimeline GraphQL 响应递归提取推文（含 quoted/retweeted 嵌套）。
 * 返回 [{ id, url, time (ISO), text, worldIds, worldNames, authorName }]。
 */
function parseSearchTimelineTweets(respObj, screenName) {
  const tweets = [];
  const seen = new Set();
  function walk(o) {
    if (o && typeof o === 'object') {
      if (o.legacy && typeof o.legacy === 'object') {
        const lg = o.legacy;
        if (lg.id_str && lg.full_text && !seen.has(lg.id_str)) {
          seen.add(lg.id_str);
          const url = `https://x.com/${screenName}/status/${lg.id_str}`;
          const time = lg.created_at ? new Date(lg.created_at).toISOString() : null;
          const parsed = extractWorldsFromTweetText(lg.full_text);
          tweets.push({ id: lg.id_str, url, time, text: lg.full_text, ...parsed });
        }
      }
      for (const v of Object.values(o)) walk(v);
    } else if (Array.isArray(o)) {
      for (const v of o) walk(v);
    }
  }
  walk(respObj);
  return tweets;
}

/**
 * X SearchTimeline GraphQL 兜底抓取：from:{screen_name} 按 Latest 排序拉取推文。
 * 相比 Nitter RSS 的 ~20 条限制，SearchTimeline 可翻页拿完整推文流，
 * 且不依赖 Nitter 实例缓存（解决 Bradlee1011 等 Nitter 404 的博主）。
 * 返回结构与 fetchCreatorRss 一致；失败时抛 X_SEARCH_UNREACHABLE。
 */
export async function fetchCreatorViaSearchTimeline(screenName, { maxTweets = 50 } = {}) {
  let guestToken;
  try {
    guestToken = await getXGuestToken();
  } catch (e) {
    const err = new Error(`X guest token 激活失败（@${screenName}）：${e.message}`);
    err.code = 'X_SEARCH_UNREACHABLE';
    throw err;
  }

  const all = [];
  let cursor = null;
  let pages = 0;
  while (all.length < maxTweets && pages < 5) {
    const variables = {
      rawQuery: `from:${screenName}`,
      count: 20,
      product: 'Latest',
      querySource: 'typed_query',
    };
    if (cursor) variables.cursor = cursor;
    const body = JSON.stringify({ queryId: X_SEARCH_QUERY_ID, variables, features: X_SEARCH_FEATURES });
    const url = `https://x.com/i/api/graphql/${X_SEARCH_QUERY_ID}/SearchTimeline`;
    const resp = await httpRequest(url, {
      headers: {
        'User-Agent': UA,
        'Authorization': `Bearer ${X_BEARER_TOKEN}`,
        'x-guest-token': guestToken,
        'Content-Type': 'application/json',
        'X-Twitter-Active-User': 'yes',
        'X-Twitter-Client-Language': 'en',
      },
      timeoutMs: 20000,
      body,
      method: 'POST',
    });
    if (resp.status !== 200) {
      const err = new Error(`X SearchTimeline 请求失败（@${screenName}）：HTTP ${resp.status}`);
      err.code = 'X_SEARCH_UNREACHABLE';
      throw err;
    }
    let obj;
    try { obj = JSON.parse(resp.body); } catch { obj = null; }
    if (!obj) break;
    const tweets = parseSearchTimelineTweets(obj, screenName);
    for (const t of tweets) {
      if (!all.some(x => x.id === t.id)) all.push(t);
    }
    // 找 bottom cursor（翻页）
    cursor = findBottomCursor(obj);
    pages++;
    if (!cursor) break;
  }
  if (all.length === 0) {
    const err = new Error(`X SearchTimeline 未返回推文（@${screenName}）`);
    err.code = 'X_SEARCH_UNREACHABLE';
    throw err;
  }
  return all;
}

/** 从 GraphQL 响应递归找 Bottom cursor（翻页游标） */
function findBottomCursor(obj) {
  if (obj && typeof obj === 'object') {
    if (obj.cursorType === 'Bottom' && obj.value) return obj.value;
    for (const v of Object.values(obj)) {
      const r = findBottomCursor(v);
      if (r) return r;
    }
  } else if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findBottomCursor(v);
      if (r) return r;
    }
  }
  return null;
}

// ── 博主清单 ──────────────────────────────────────────────

export function getCreators(storage) {
  const raw = storage.getConfig('x_creators');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function setCreators(storage, creators) {
  storage.setConfig('x_creators', JSON.stringify(creators));
}

/**
 * 添加博主（upsert）。entry: { screen_name, name? }
 */
export function addCreator(storage, entry) {
  const creators = getCreators(storage);
  const screen = (entry.screen_name || '').replace(/^@/, '').trim();
  if (!screen) throw new Error('screen_name is required');
  const existing = creators.find(c => c.screen_name === screen);
  if (existing) {
    if (entry.name) existing.name = entry.name;
    return { added: false, creators: getCreators(storage) };
  }
  creators.push({ screen_name: screen, name: entry.name || screen });
  setCreators(storage, creators);
  return { added: true, creators: getCreators(storage) };
}

export function removeCreator(storage, screenName) {
  const creators = getCreators(storage);
  const screen = (screenName || '').replace(/^@/, '').trim();
  const next = creators.filter(c => c.screen_name !== screen);
  if (next.length === creators.length) {
    return { removed: false, creators: getCreators(storage) };
  }
  setCreators(storage, next);
  return { removed: true, creators: next };
}

// ── Nitter RSS 抓取（多实例回退 + 代理支持，见上方 fetchCreatorRss） ──

/**
 * 从单条推文文本提取世界信息（RSS 与 SearchTimeline 共用）。
 * 返回 { worldIds: string[], worldNames: string[], authorName: string }。
 */
export function extractWorldsFromTweetText(text) {
  const fullText = text || '';

  // 世界链接：vrchat.com/home/world/wrld_xxx 或 vrchat.com/home/launch?worldId=wrld_xxx
  const worldIds = [...new Set(
    [
      ...fullText.matchAll(/vrchat\.com\/home\/world\/(wrld_[0-9a-f-]+)/gi),
      ...fullText.matchAll(/vrchat\.com\/home\/launch\?[^"'\s]*worldId=([0-9a-f-]+)/gi),
      ...fullText.matchAll(/vrchat\.com\/home\/launch\?worldId=wrld_([0-9a-f-]+)/gi),
    ].map(x => {
      // 归一化：带 wrld_ 前缀的直接用；launch 里可能带或不带前缀
      const raw = x[1];
      return raw.startsWith('wrld_') ? raw : `wrld_${raw}`;
    }).filter(id => {
      // 过滤截断残片：RSS 链接显示文本可能被省略号截断（如 wrld_6…、wrld_d593cc64-de55-496c-9f83-）
      // 合法 worldId = "wrld_" + 8-4-4-4-12 的 UUID（36 字符 + 5 前缀 = 41），残片长度不足直接丢弃
      const hex = id.slice(5).replace(/-/g, '');
      return /^[0-9a-f]{32}$/i.test(hex);
    })
  )];

  // 世界名（多格式兼容）：
  //   "World: XXX" / "ワールド：XXX" / "World name: XXX" / "World：XXX"
  // 名字在 By:/Platform:/换行/# 处截断，避免吞掉作者和描述
  const worldNames = [];
  const nameRe = /(?:World(?:\s*name)?|ワールド)\s*[:：]\s*([^\n#|]{2,80}?)(?=\s*(?:By|by|作者|Platform|プラットフォーム)[:：]|\n|#|\||$)/gi;
  let nm;
  while ((nm = nameRe.exec(fullText)) !== null) {
    const name = nm[1].replace(/https?:\/\/\S+/g, '').trim().replace(/[|｜].*$/, '').trim();
    if (name && !worldNames.includes(name)) worldNames.push(name);
  }

  // 作者名提取（By: XXX，到 Platform/#/换行/描述边界截断）
  const authorName = extractAuthor(fullText);

  // 三行格式（八谷凛奈等）："世界名\n作者名\n-- 描述" 或 "世界名 作者名 -- 描述"
  // 且文本带 #VRChat_world紹介
  const looksLikeWorldIntro = /#VRChat_world紹介|#VRChat_world紹介|ワールド紹介|World.*紹介/i.test(fullText);
  if (looksLikeWorldIntro && worldNames.length === 0 && worldIds.length === 0) {
    const inline = fullText.match(/([^\n#|]{2,60}?)\s+([A-Za-z0-9_\-\.]{2,40})\s+--\s+/);
    const threeLine = !inline
      ? fullText.match(/([^\n]{2,60})\n\s*([A-Za-z0-9_\-\.]{2,40})\n\s*--/)
      : null;
    const matched = inline || threeLine;
    if (matched) {
      const wName = matched[1].trim();
      if (wName && !/[#|]/.test(wName) && !/^RT\b/.test(wName)) {
        worldNames.push(wName);
      }
    }
  }

  return { worldIds, worldNames, authorName };
}

/**
 * 解析 Nitter RSS XML → 推文数组
 */
export function parseRss(xml, screenName) {
  const tweets = [];
  // 提取 <item> 块
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTag(block, 'title') || '';
    const link = extractTag(block, 'link') || '';
    const pubDate = extractTag(block, 'pubDate') || '';
    const desc = extractTag(block, 'description') || '';

    const tweetIdMatch = link.match(/\/status\/(\d+)/);
    const tweetId = tweetIdMatch ? tweetIdMatch[1] : '';
    const time = pubDate ? new Date(pubDate).toISOString() : null;

    // 合并 title + description 提取世界信息（Nitter 的 description 含完整链接）
    const fullText = `${title} ${stripHtml(desc)}`;
    const { worldIds, worldNames, authorName } = extractWorldsFromTweetText(fullText);

    tweets.push({
      id: tweetId,
      url: link,
      time,
      text: title,
      worldIds,
      worldNames,
      authorName,
    });
  }
  return tweets;
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? decodeXml(m[1]) : '';
}

function stripHtml(s) {
  // 块级标签保留换行（<br>、</p>、</blockquote>、<hr>），其余标签清掉
  // <a href="..."> 保留完整 URL（显示文本可能被截断，如 vrchat.com/home/launch?world…）
  // 先剥离 CDATA 标记（<![CDATA[ 无 > 会吞掉后续首个标签）
  return s
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>/gi, '$1 ')
    .replace(/<a\s+[^>]*href='([^']+)'[^>]*>/gi, '$1 ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|blockquote|div|li)>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * 名称归一化：小写、去空格/全角空格、去零宽字符，用于匹配比较
 */
function normalizeName(s) {
  return (s || '').toLowerCase().replace(/[\s\u3000\u200b-\u200d\ufeff]+/g, '').trim();
}

/**
 * 从推文文本提取作者名（By: XXX 格式）。
 * 截断边界：Platform/プラットフォーム/#/换行/竖线/行尾。
 * 注意：无 Platform 分隔的格式（如 "World:X By:Y 描述..."）作者后紧跟描述，
 * 此时可能带出描述开头——但这类推文通常有链接（走 worldIds 路径），
 * 只有名字搜索的推文（Bradlee101 格式）都有 Platform 分隔，提取准确。
 */
function extractAuthor(text) {
  const m = text.match(/(?:^|\s)By\s*[:：]\s*([^\n#|]{2,40}?)(?=\s*(?:Platform|プラットフォーム)[:：]?|\n|#|\||$)/i);
  return m ? m[1].trim() : '';
}

// ── 世界数据查询 ───────────────────────────────────────────

/**
 * 查世界详情（VRChat API），带限流。返回完整统计字段或 null。
 * worldId 或 worldName 二选一（worldName 走搜索，取第一个结果）。
 */
export async function fetchWorldStats(api, rateLimiter, { worldId, worldName, authorName }) {
  try {
    if (worldId) {
      return await fetchWorldDetail(api, rateLimiter, worldId);
    }
    if (worldName) {
      // 搜索兜底：按名字查世界，拿到 worldId 后再查详情（搜索端点不含 visits）
      const r = await rateLimiter.execute(() => api._request('GET', `/worlds?search=${encodeURIComponent(worldName)}&n=10`));
      if (r.status === 200 && Array.isArray(r.data) && r.data.length > 0) {
        // 匹配策略（VRChat 搜索对中日文/短名匹配极差，需多重校验防误报）：
        // 1. 作者名强过滤：若推文带 By: 作者，结果作者必须匹配（归一化忽略大小写/空格）
        // 2. 名字精确匹配优先，其次包含匹配
        // 3. 无匹配返回 null（宁可漏抓，不可错记）
        const target = normalizeName(worldName);
        const targetAuthor = authorName ? normalizeName(authorName) : '';
        let exact = null;    // 名字精确匹配
        let inclAuthor = null; // 名字包含且作者匹配
        let incl = null;     // 名字包含（无作者约束）

        for (const w of r.data) {
          const wname = normalizeName(w.name || '');
          const wauthor = normalizeName(w.authorName || '');
          const nameMatch = wname === target;
          const containsMatch = wname.includes(target) || target.includes(wname);
          const authorMatch = targetAuthor && (wauthor === targetAuthor || wauthor.includes(targetAuthor) || targetAuthor.includes(wauthor));

          if (nameMatch && (!targetAuthor || authorMatch)) { exact = w; break; }
          if (!exact && containsMatch && (!targetAuthor || authorMatch)) inclAuthor = w;
          // 无作者约束时才用纯包含兜底（有作者名时必须作者匹配，防误报）
          if (!exact && !inclAuthor && containsMatch && !targetAuthor) incl = w;
        }

        const first = exact || inclAuthor || incl || null;
        if (!first) {
          // 名字搜索失败且有作者名 → 用 userId 参数精确搜该作者的世界
          // （VRChat 搜索对短名/新世界常搜不到，userId 过滤能直达作者作品）
          if (targetAuthor) {
            return await fetchWorldByAuthor(api, rateLimiter, worldName, authorName);
          }
          return null;
        }
        // 搜索响应若已含 visits 直接映射，否则补查详情
        if (first && typeof first.visits === 'number') {
          return mapWorld(first);
        }
        if (first && first.id) {
          return await fetchWorldDetail(api, rateLimiter, first.id);
        }
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 查世界详情端点（含完整统计：favorites/visits/popularity） */
async function fetchWorldDetail(api, rateLimiter, worldId) {
  const r = await rateLimiter.execute(() => api._request('GET', `/worlds/${encodeURIComponent(worldId)}`));
  if (r.status === 200 && r.data) return mapWorld(r.data);
  return null;
}

/**
 * 按作者名搜世界：先查作者的 userId，再带 userId 参数搜世界。
 * 用于名字搜索失败时（VRChat 搜索对短名/新世界常搜不到）。
 */
async function fetchWorldByAuthor(api, rateLimiter, worldName, authorName) {
  try {
    // 1) 搜作者 userId（取第一个精确匹配）
    const ur = await rateLimiter.execute(() => api._request('GET', `/users?search=${encodeURIComponent(authorName)}&n=5`));
    if (ur.status !== 200 || !Array.isArray(ur.data) || ur.data.length === 0) return null;
    const target = normalizeName(authorName);
    let user = null;
    for (const u of ur.data) {
      if (normalizeName(u.displayName || '') === target) { user = u; break; }
    }
    if (!user) user = ur.data[0];
    if (!user?.id) return null;

    // 2) 带 userId 搜该作者的世界
    const wr = await rateLimiter.execute(() => api._request('GET', `/worlds?search=${encodeURIComponent(worldName)}&userId=${encodeURIComponent(user.id)}&n=10`));
    if (wr.status === 200 && Array.isArray(wr.data) && wr.data.length > 0) {
      // 名字匹配（作者已被 userId 过滤）
      const targetName = normalizeName(worldName);
      let best = null;
      for (const w of wr.data) {
        const wname = normalizeName(w.name || '');
        if (wname === targetName) { best = w; break; }
        if (!best && (wname.includes(targetName) || targetName.includes(wname))) best = w;
      }
      if (best) {
        if (typeof best.visits === 'number') return mapWorld(best);
        if (best.id) return await fetchWorldDetail(api, rateLimiter, best.id);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function mapWorld(w) {
  return {
    worldId: w.id,
    worldName: w.name,
    authorName: w.authorName || '',
    description: (w.description || '').slice(0, 500),
    imageUrl: w.imageUrl || '',
    favorites: w.favorites || 0,
    visits: w.visits || 0,
    popularity: w.popularity || 0,
    capacity: w.capacity || 0,
    tags: Array.isArray(w.tags) ? w.tags : [],
  };
}

// ── 扫描主流程 ─────────────────────────────────────────────

/**
 * 统一抓取入口：先 Nitter RSS（主源），失败/空回退 X SearchTimeline（兜底）。
 * 返回 { tweets, source }，source ∈ 'nitter' | 'search_timeline'。
 * 两者都失败时抛 X_FETCH_ALL_FAILED（含诊断）。
 */
export async function fetchCreatorTweets(screenName) {
  try {
    const tweets = await fetchCreatorRss(screenName);
    return { tweets, source: 'nitter' };
  } catch (e) {
    log(`⚠️ x-world @${screenName} Nitter 不可达，回退 X SearchTimeline：${e.message}`);
  }
  try {
    const tweets = await fetchCreatorViaSearchTimeline(screenName);
    return { tweets, source: 'search_timeline' };
  } catch (e2) {
    const err = new Error(`@${screenName} 双数据源均失败（Nitter + X SearchTimeline）：${e2.message}。建议检查网络或设置 HTTPS_PROXY。`);
    err.code = 'X_FETCH_ALL_FAILED';
    throw err;
  }
}

/**
 * 抓取所有博主的最新推文 → 提取世界 → 查询统计 → 写入数据库。
 * 返回本次扫描摘要。
 */
export async function scanCreatorWorlds({ force = false } = {}) {
  const { storage, api, rateLimiter } = ctx;
  const creators = getCreators(storage);
  if (creators.length === 0) {
    return { scanned: 0, tweets: 0, worlds: 0, creators: [], message: '未配置博主，请先用 x_add_creator 添加' };
  }

  const results = [];
  let totalTweets = 0;
  let totalWorlds = 0;

  for (const creator of creators) {
    const screen = creator.screen_name;
    try {
      const { tweets } = await fetchCreatorTweets(screen);
      totalTweets += tweets.length;

      // 收集该博主推荐的世界（按推文时间去重，跨推文合并）
      const seenWorlds = new Map(); // worldId -> {tweetId, tweetTime, tweetUrl}
      const pendingByName = [];     // 只有名字的世界

      for (const t of tweets) {
        for (const wid of t.worldIds) {
          if (!seenWorlds.has(wid)) {
            seenWorlds.set(wid, { tweetId: t.id, tweetTime: t.time, tweetUrl: t.url });
          }
        }
        for (const name of t.worldNames) {
          if (t.worldIds.length === 0) {
            pendingByName.push({ name, authorName: t.authorName, tweetId: t.id, tweetTime: t.time, tweetUrl: t.url });
          }
        }
      }

      let saved = 0;
      // 1) 有链接的世界
      for (const [wid, info] of seenWorlds) {
        const stats = await fetchWorldStats(api, rateLimiter, { worldId: wid });
        if (stats) {
          saveRecommendation(storage, creator, stats, info);
          saved++;
        }
      }
      // 2) 只有名字的（搜索兜底，带作者名辅助匹配）
      for (const item of pendingByName) {
        const stats = await fetchWorldStats(api, rateLimiter, { worldName: item.name, authorName: item.authorName });
        if (stats) {
          saveRecommendation(storage, creator, stats, item);
          saved++;
        }
      }
      totalWorlds += saved;
      results.push({ screen_name: screen, name: creator.name || screen, tweets: tweets.length, worlds: saved });
    } catch (e) {
      log(`❌ x-world scan @${screen}: ${e.message}`);
      // 结构化错误：双源均失败 → 用户可读的降级提示
      const errorInfo = e.code === 'X_FETCH_ALL_FAILED'
        ? `Nitter 与 X SearchTimeline 双数据源均不可达（网络受限/需代理）。请在服务环境设置 HTTPS_PROXY 或 VRC_MONITOR_HTTP_PROXY 后重试。`
        : e.message;
      results.push({ screen_name: screen, name: creator.name || screen, tweets: 0, worlds: 0, error: errorInfo });
    }
  }

  return { scanned: creators.length, tweets: totalTweets, worlds: totalWorlds, creators: results };
}

/**
 * 写入/更新推荐记录（跨博主去重累积）。
 */
export function saveRecommendation(storage, creator, world, tweetInfo) {
  const existing = storage.getXWorld(world.worldId);
  const rec = {
    tweetId: tweetInfo.tweetId || '',
    tweetTime: tweetInfo.tweetTime || new Date().toISOString(),
    tweetUrl: tweetInfo.tweetUrl || '',
  };

  if (existing) {
    // 更新统计 + 追加推荐记录
    let creatorsArr = [];
    try { creatorsArr = JSON.parse(existing.creators || '[]'); } catch {}
    const prev = creatorsArr.find(c => c.screen_name === creator.screen_name && c.tweet_id === rec.tweetId);
    if (!prev) {
      creatorsArr.push({
        screen_name: creator.screen_name,
        name: creator.name || creator.screen_name,
        tweet_id: rec.tweetId,
        tweet_time: rec.tweetTime,
        tweet_url: rec.tweetUrl,
      });
    }
    storage.updateXWorld(existing.world_id, {
      worldName: world.worldName || existing.world_name,
      authorName: world.authorName || existing.author_name,
      description: world.description || existing.description,
      imageUrl: world.imageUrl || existing.image_url,
      favorites: world.favorites,
      visits: world.visits,
      popularity: world.popularity,
      capacity: world.capacity,
      tags: JSON.stringify(world.tags),
      lastRecommendedAt: rec.tweetTime,
      creators: JSON.stringify(creatorsArr),
      tweetCount: creatorsArr.length,
    });
  } else {
    storage.insertXWorld({
      worldId: world.worldId,
      worldName: world.worldName,
      authorName: world.authorName,
      description: world.description,
      imageUrl: world.imageUrl,
      favorites: world.favorites,
      visits: world.visits,
      popularity: world.popularity,
      capacity: world.capacity,
      tags: JSON.stringify(world.tags),
      firstSeenAt: rec.tweetTime,
      lastRecommendedAt: rec.tweetTime,
      creators: JSON.stringify([{
        screen_name: creator.screen_name,
        name: creator.name || creator.screen_name,
        tweet_id: rec.tweetId,
        tweet_time: rec.tweetTime,
        tweet_url: rec.tweetUrl,
      }]),
      tweetCount: 1,
    });
  }
}

// ── 聚合查询（digest） ──────────────────────────────────────

/**
 * 按时间窗口聚合博主推荐的世界，按收藏数排序。
 *
 * days: 1/3/7/15/30 —— 只看 last_recommended_at 在最近 N 天内的世界
 * highlightRatio: 收藏/浏览比超过该值标注为重点（默认 0.2 = 五分之一）
 * 返回结构可直接展示。
 */
export function getWorldDigest({ days = 7, highlightRatio = 0.2, limit = 50, creator } = {}) {
  const { storage } = ctx;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = storage.getXWorldsSince(since, { creator, limit: limit * 3 }); // 多取一些便于排序

  const worlds = rows.map(r => {
    let creatorsArr = [];
    try { creatorsArr = JSON.parse(r.creators || '[]'); } catch {}
    const favorites = r.favorites || 0;
    const visits = r.visits || 0;
    const ratio = visits > 0 ? favorites / visits : 0;
    const highlight = ratio >= highlightRatio;
    return {
      worldId: r.world_id,
      worldName: r.world_name,
      authorName: r.author_name,
      description: (r.description || '').slice(0, 120),
      favorites,
      visits,
      popularity: r.popularity || 0,
      capacity: r.capacity || 0,
      favoriteVisitRatio: Number(ratio.toFixed(3)),
      highlight,                    // 收藏/浏览比 ≥ 1/5
      creators: [...new Set(creatorsArr.map(c => c.name || c.screen_name))],
      lastRecommendedAt: r.last_recommended_at,
      tweetCount: r.tweet_count || 0,
      tags: safeParseTags(r.tags),
    };
  });

  // 按收藏数降序
  worlds.sort((a, b) => b.favorites - a.favorites);

  const highlighted = worlds.filter(w => w.highlight);
  return {
    days,
    highlightRatio,
    total: worlds.length,
    highlightedCount: highlighted.length,
    highlighted: highlighted.slice(0, limit),
    worlds: worlds.slice(0, limit),
  };
}

function safeParseTags(s) {
  try { const t = JSON.parse(s || '[]'); return Array.isArray(t) ? t : []; }
  catch { return []; }
}
