import { gzipSync } from 'node:zlib';

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

export function sendHtml(res, html) {
  const body = Buffer.from(html);
  if (acceptsGzip(res) && body.length > 1024) {
    const gz = gzipSync(body);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Encoding': 'gzip',
      'Content-Length': gz.length,
    });
    return res.end(gz);
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
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
