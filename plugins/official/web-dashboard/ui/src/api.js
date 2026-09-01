// API 封装：token 注入 + fetch/SSE（移植自旧 core.js）
const TOKEN_KEY = 'vrc_dashboard_token';
const token = new URLSearchParams(location.search).get('token') || sessionStorage.getItem(TOKEN_KEY) || '';
if (token) sessionStorage.setItem(TOKEN_KEY, token);
// 登录页使用：从 URL 读到的 token 立即清理 URL（防泄露在地址栏），值保留在 sessionStorage
try {
  if (new URLSearchParams(location.search).get('token') && typeof history !== 'undefined') {
    history.replaceState(null, '', location.pathname + location.hash);
  }
} catch { /* 测试环境无 history 时跳过 URL 清理 */ }

export const hasToken = () => !!getToken();
export function getToken() { return sessionStorage.getItem(TOKEN_KEY) || ''; }
export function setToken(t) { sessionStorage.setItem(TOKEN_KEY, t); }
export function clearToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
  try { window.dispatchEvent(new CustomEvent('vrc-auth-401')); } catch {}
}
// 401 → 清 token 并通知 App 显示登录页（会话过期/服务重启后 token 失效）
function handle401() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
  try { window.dispatchEvent(new CustomEvent('vrc-auth-401')); } catch {}
}

export const apiUrl = (p) => (getToken() ? `${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken())}` : p);

// 统一错误信息：401 = 会话过期/服务未就绪（容器重启后 TOTP 自动登录自愈，稍等刷新即可）
const errMsg = (r) => (r.status === 401
  ? '会话过期或服务未就绪（容器重启中会自动恢复，稍后重试）'
  : 'HTTP ' + r.status);

export async function get(p, timeout = 25000) {
  const r = await fetch(apiUrl(p), { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) { if (r.status === 401) handle401(); throw new Error(errMsg(r)); }
  return r.json();
}

export async function post(p, body = {}, timeout = 25000) {
  const r = await fetch(apiUrl(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) { if (r.status === 401) handle401(); throw new Error(errMsg(r)); }
  return r.json();
}

// 读接口 TTL 缓存（60s）：轮询型/重复加载的视图（动态、好友、概览等）避免重复请求。
// 写操作（post）后调用 invalidateCache(path) 强制下次刷新。
const CACHE_TTL = 60_000;
const cacheMap = new Map();   // path -> { at, data }

export async function getCached(p, timeout = 25000) {
  const hit = cacheMap.get(p);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  const data = await get(p, timeout);
  cacheMap.set(p, { at: Date.now(), data });
  return data;
}

export function invalidateCache(p) {
  if (p) { cacheMap.delete(p); return; }
  cacheMap.clear();
}

export function openSse(onEvent, onStatus) {
  try {
    const es = new EventSource(apiUrl('/api/dashboard/stream'));
    es.onopen = () => onStatus && onStatus('connected');
    es.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data);
        if (d.type === 'event' && d.event) onEvent && onEvent(d.event);
      } catch {}
    };
    es.onerror = () => onStatus && onStatus('reconnecting');
    return es;
  } catch {
    return null;
  }
}

// VRChat 图片统一走路由器代理（浏览器直连 api.vrchat.cloud 可能被墙/无法访问），
// 代理 URL 带 token 通过鉴权；非 VRChat 域名原样返回。
const IMG_HOSTS = ['api.vrchat.cloud', 'd348imysud55la.cloudfront.net', 'assets.vrchat.com', 'files.vrchat.cloud'];
export function imgUrl(url) {
  if (!url) return '';
  if (String(url).startsWith('/api/dashboard/image-proxy')) return url;
  try {
    const u = new URL(url);
    const ok = IMG_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
    if (!ok) return url;
  } catch {
    return url;
  }
  return `/api/dashboard/image-proxy?url=${encodeURIComponent(url)}&token=${encodeURIComponent(getToken())}`;
}
