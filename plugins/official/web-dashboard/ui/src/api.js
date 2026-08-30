// API 封装：token 注入 + fetch/SSE（移植自旧 core.js）
const token = new URLSearchParams(location.search).get('token') || sessionStorage.getItem('vrc_dashboard_token') || '';
if (token) sessionStorage.setItem('vrc_dashboard_token', token);

export const apiUrl = (p) => (token ? `${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : p);

// 统一错误信息：401 = 会话过期/服务未就绪（容器重启后 TOTP 自动登录自愈，稍等刷新即可）
const errMsg = (r) => (r.status === 401
  ? '会话过期或服务未就绪（容器重启中会自动恢复，稍后重试）'
  : 'HTTP ' + r.status);

export async function get(p, timeout = 25000) {
  const r = await fetch(apiUrl(p), { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(errMsg(r));
  return r.json();
}

export async function post(p, body = {}, timeout = 25000) {
  const r = await fetch(apiUrl(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(errMsg(r));
  return r.json();
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
  return `/api/dashboard/image-proxy?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`;
}
