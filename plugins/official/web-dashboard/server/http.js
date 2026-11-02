import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/** 内容 ETag（sha1 前 16 位）——使用者 2026-09-22 反馈「无痕打开登录页也要 15 秒」：
 *  页面 1.5MB（gzip 后 ~480KB）此前只有 no-cache、没有任何校验器 ⇒ 只要回源就整包重下 ✗；
 *  加 ETag 后浏览器可带 If-None-Match 复验，内容未变直接 304 = 零正文 ✓✓。
 *  **边界（2026-10-18 复审 💡2 指出，如实写清）**：只覆盖「已有缓存且内容未变」这一半 ——
 *  无痕窗口 / 新会话本来就是空缓存，首次仍要下完整包体；首次优化要靠减小包体或流式首屏，不在本函数职责内。 */
// 返回**不透明**的带引号串；下发时加 W/ 前缀（见 etagHeader）。
// 理由（复审 nixi-agent 💡1）：同一个 tag 同时描述 gzip 与 identity 两种**字节不同**的表示，
// 按 RFC 9110 §8.8.1 强校验器要求「同 tag ⇒ 字节相同」⇒ 这里只能是**弱**校验器。
function etagOf(body) {
  return '"' + createHash('sha1').update(body).digest('hex').slice(0, 16) + '"';
}

// 下发的 ETag 头：弱校验器。客户端原样回传（W/"…"），比较侧剥掉 W/ 后比不透明部分。
const etagHeader = (opaque) => 'W/' + opaque;

/** If-None-Match 是否命中当前 ETag：
 *  ① 逗号分隔多值逐个比较（浏览器与中间缓存会带多个）；
 *  ② '*' 直接命中（RFC 9110 §13.1.2：GET 语义下「已有任何表示」即 304）；
 *  ③ 弱校验器（W/ 前缀）剥掉前缀再比 —— If-None-Match 用的是**弱比较**语义。 */
function ifNoneMatchHits(inm, tag) {
  const raw = String(inm || '').trim();
  if (!raw) return false;
  return raw.split(',').some((item) => {
    const t = item.trim();
    if (t === '*') return true;
    const opaque = t.startsWith('W/') ? t.slice(2) : t;
    return opaque === tag;
  });
}

// 客户端接受 gzip 且 body 足够大时压缩——动态流 JSON ~80KB→~12KB，单文件页面 1.27MB→~300KB（家宽上行显著提速）
function acceptsGzip(res) {
  const enc = (res && res.req && res.req.headers && res.req.headers['accept-encoding']) || '';
  return enc.toLowerCase().split(',').some((t) => t.trim() === 'gzip');
}

export function sendJson(res, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload));
  if (acceptsGzip(res) && body.length > 1024) {
    const gz = gzipSync(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Encoding': 'gzip',
      'Content-Length': gz.length,
    });
    return res.end(gz);
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

/** 单文件页面的 gzip 缓存（按内容哈希）：
 *  页面只在部署时变化，但每次「回源且客户端未命中缓存」都要重新 gzipSync 一遍 ~1MB 正文
 *  （实测 35ms/次，且是**同步**压缩 ⇒ 直接阻塞事件循环，与并发的数据请求抢主线程）。
 *  以内容 sha1 为键缓存压缩结果：同一份产物只压一次，重复请求直接复用 Buffer。
 *  上限 2 条（当前产物 + 上一版），避免部署多次后无限增长。 */
const htmlGzipCache = new Map();   // tag -> { gz: Buffer }
const HTML_GZIP_CACHE_MAX = 2;

function gzipHtmlCached(tag, body) {
  const hit = htmlGzipCache.get(tag);
  if (hit) return hit;
  const gz = gzipSync(body, { level: 9 });
  if (htmlGzipCache.size >= HTML_GZIP_CACHE_MAX) {
    htmlGzipCache.delete(htmlGzipCache.keys().next().value);   // FIFO：淘汰最旧的一份
  }
  htmlGzipCache.set(tag, { gz });
  return { gz };
}

export function sendHtml(res, html) {
  const body = Buffer.from(html);
  const tag = etagOf(body);
  const inm = String((res.req && res.req.headers && res.req.headers['if-none-match']) || '');
  if (ifNoneMatchHits(inm, tag)) {
    // Vary 必须有：同一 ETag 同时描述 gzip 与 identity 两种表示，缺了它共享缓存（反代/CDN）可能
    // 存下 gzip 表示再对只收 identity 的客户端复验并回 304 ⇒ 把 gzip 字节发给不收 gzip 的客户端。
    // 304 是**无表示**响应 ⇒ 不得带表示头（Content-Encoding / Content-Length / Content-Type）：
    // 带了会让中间缓存把它当成「新表示」，甚至按 304 的头覆盖已存表示的元数据。
    // 故本分支只发 ETag / Cache-Control / Vary 三个（2026-10-18 复审 nixi-agent 记录性建议）。
    res.writeHead(304, { ETag: etagHeader(tag), 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' });
    return res.end();
  }
  if (acceptsGzip(res) && body.length > 1024) {
    const gz = gzipHtmlCached(tag, body).gz;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'ETag': etagHeader(tag),
      'Vary': 'Accept-Encoding',
      'Content-Encoding': 'gzip',
      'Content-Length': gz.length,
    });
    return res.end(gz);
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'ETag': etagHeader(tag),
    'Vary': 'Accept-Encoding',
    'Content-Length': body.length,
  });
  res.end(body);
}

export function parseLimit(value, fallback, maximum) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), maximum);
}

export function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { tooLarge = true; body = ''; req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) { reject(new Error('请求体超过上限')); return; }
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('请求体不是有效 JSON')); }
    });
    req.on('error', reject);
  });
}
