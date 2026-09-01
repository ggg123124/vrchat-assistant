// VRChat 图片代理与加速缓存：解决公网 / 移动端访问时 api.vrchat.cloud CDN 被阻断或无法直连的问题
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALLOWED_HOSTS = [
  'api.vrchat.cloud',
  'd348imysud55la.cloudfront.net',
  'assets.vrchat.com',
  'files.vrchat.cloud',
];

// 内存 LRU 简易缓存（最大缓存 100 张最近头像/缩略图，避免重复回源）
const imageCache = new Map();
const MAX_CACHE = 120;

// 磁盘缓存：持久化，30 天 TTL
const CACHE_DIR = path.join(__dirname, '..', '..', '..', '..', '..', 'data', 'img-cache');
const DISK_TTL = 30 * 24 * 60 * 60 * 1000;

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  }
}

function getCacheHash(url) {
  return createHash('md5').update(url).digest('hex');
}

function extFromContentType(ct) {
  if (!ct) return '';
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
  };
  const mime = ct.toLowerCase().split(';')[0].trim();
  return map[mime] || '';
}

function detectContentType(buf) {
  if (!buf || buf.length < 4) return 'application/octet-stream';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'application/octet-stream';
}

function contentTypeFromExt(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  return map[ext] || '';
}

async function findCacheFile(hash) {
  for (const ext of ['png', 'jpg', 'gif', 'webp']) {
    const p = path.join(CACHE_DIR, `${hash}.${ext}`);
    try {
      await fs.access(p);
      return p;
    } catch {}
  }
  const p = path.join(CACHE_DIR, hash);
  try {
    await fs.access(p);
    return p;
  } catch {}
  return null;
}

async function readDiskCache(url) {
  try {
    const hash = getCacheHash(url);
    const filePath = await findCacheFile(hash);
    if (!filePath) return null;
    const stat = await fs.stat(filePath);
    if (Date.now() - stat.mtime.getTime() > DISK_TTL) return null;
    const buffer = await fs.readFile(filePath);
    const contentType = contentTypeFromExt(filePath) || detectContentType(buffer);
    return { buffer, contentType, time: stat.mtime.getTime() };
  } catch { return null; }
}

async function writeDiskCache(url, buffer, contentType) {
  try {
    ensureCacheDir();
    const hash = getCacheHash(url);
    const ext = extFromContentType(contentType);
    const fileName = ext ? `${hash}.${ext}` : hash;
    // 清理同一 hash 的其它扩展名旧文件（content-type 可能变化）
    for (const e of ['', 'png', 'jpg', 'gif', 'webp']) {
      const old = e ? `${hash}.${e}` : hash;
      const oldPath = path.join(CACHE_DIR, old);
      try { await fs.unlink(oldPath); } catch {}
    }
    await fs.writeFile(path.join(CACHE_DIR, fileName), buffer);
  } catch {}
}

// 回源并发限制：首次加载大量图片同时回源易触发 VRChat 限流（429/403）→ 最多 4 个并发，其余排队
let inflight = 0;
const MAX_INFLIGHT = 4;
async function waitSlot() {
  while (inflight >= MAX_INFLIGHT) await new Promise((r) => setTimeout(r, 120));
  inflight++;
}
function releaseSlot() { inflight--; }

const DEFAULT_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 24 24" fill="none" stroke="#6e7d8c" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>`;

export function registerImageProxyRoutes(api) {
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/image-proxy',
    handler: async (req, res) => {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const targetUrl = urlObj.searchParams.get('url');
        if (!targetUrl) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          return res.end('missing url parameter');
        }

        let parsed;
        try {
          parsed = new URL(targetUrl);
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          return res.end('invalid url');
        }

        // 安全检查：仅允许白名单域名
        const isAllowed = ALLOWED_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h));
        if (!isAllowed) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          return res.end('host not allowed');
        }

        // 检查磁盘缓存（持久化，30 天）
        const diskCached = await readDiskCache(targetUrl);
        if (diskCached) {
          // 回填内存缓存，下次更快
          if (imageCache.size >= MAX_CACHE) {
            const firstKey = imageCache.keys().next().value;
            imageCache.delete(firstKey);
          }
          imageCache.set(targetUrl, { contentType: diskCached.contentType, buffer: diskCached.buffer, time: diskCached.time });
          res.writeHead(200, {
            'Content-Type': diskCached.contentType,
            'Cache-Control': 'public, max-age=86400, immutable',
            'Content-Length': diskCached.buffer.length,
          });
          return res.end(diskCached.buffer);
        }

        // 检查内存缓存
        const cached = imageCache.get(targetUrl);
        if (cached && (Date.now() - cached.time < 3600 * 1000 * 6)) {
          res.writeHead(200, {
            'Content-Type': cached.contentType,
            'Cache-Control': 'public, max-age=86400, immutable',
            'Content-Length': cached.buffer.length,
          });
          return res.end(cached.buffer);
        }

        // 通过路由器的网络（具备 VRChat 访问能力）拉取图片
        const fetchImage = async (u) => {
          await waitSlot();
          try {
            return await fetch(u, {
              headers: {
                'User-Agent': 'VRCX-Web-Dashboard/1.0',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              },
              signal: AbortSignal.timeout(12000),
            });
          } catch { return null; }  // 网络错返回 null，由调用方重试逻辑处理
          finally { releaseSlot(); }
        };

        let resp = await fetchImage(targetUrl);
        // 网络抖动/临时限流（429/5xx/连接失败）时重试：一次失败直接占位会造成头像"有概率不显示"
        for (let attempt = 0; (!resp || !resp.ok) && attempt < 2; attempt++) {
          await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
          resp = await fetchImage(targetUrl);
        }
        // 缩略图 404 → 回退完整图：部分 file 无 /1/image/ 缩略图（VRChat 清理/非图片类型）
        if (!resp || !resp.ok) {
          const fallback = targetUrl.replace(/\/api\/1\/image\/(file_[a-f0-9-]+)\/\d+\/\d+/, '/api/1/file/$1/1/file');
          if (fallback !== targetUrl) {
            resp = await fetchImage(fallback);
            for (let attempt = 0; (!resp || !resp.ok) && attempt < 2; attempt++) {
              await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
              resp = await fetchImage(fallback);
            }
          }
        }

        if (!resp || !resp.ok) {
          // 上游拉取失败时返回默认 SVG 占位图；不缓存（避免浏览器记住占位导致修复后仍显示默认头像）
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-store',
          });
          return res.end(DEFAULT_AVATAR_SVG);
        }

        const contentType = resp.headers.get('content-type') || 'image/jpeg';
        const buffer = Buffer.from(await resp.arrayBuffer());

        // 写入磁盘缓存（持久化）和内存缓存
        await writeDiskCache(targetUrl, buffer, contentType);
        if (imageCache.size >= MAX_CACHE) {
          const firstKey = imageCache.keys().next().value;
          imageCache.delete(firstKey);
        }
        imageCache.set(targetUrl, { contentType, buffer, time: Date.now() });

        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400, immutable',
          'Content-Length': buffer.length,
        });
        res.end(buffer);
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=60' });
        res.end(DEFAULT_AVATAR_SVG);
      }
    },
  });
}
