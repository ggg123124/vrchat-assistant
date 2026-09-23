// api.js 层单测（重构行为等价锚点——token 注入/缓存语义/401 文案/图片代理白名单）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟浏览器环境（location/sessionStorage/fetch/EventSource）
const origLocation = globalThis.location;
const origSessionStorage = globalThis.sessionStorage;
const origFetch = globalThis.fetch;
const origEventSource = globalThis.EventSource;

function setupEnv(search = '') {
  globalThis.location = { search, pathname: '/dashboard' };
  const mem = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
  };
}

afterEach(() => {
  globalThis.location = origLocation;
  globalThis.sessionStorage = origSessionStorage;
  globalThis.fetch = origFetch;
  globalThis.EventSource = origEventSource;
  vi.resetModules();
});

/** 记录调用参数的 fetch 替身；按 statuses 顺序返回 Response 样式对象（镜像 auth-gate.test.js）。 */
function stubFetch(statuses) {
  const calls = [];
  const queue = [...statuses];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const status = queue.length ? queue.shift() : 200;
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
  });
  return calls;
}

describe('令牌传输：普通请求走 Authorization 头、不进 URL（issue #217）', () => {
  it('get() 带 Authorization，URL 不含 token=', async () => {
    setupEnv('?token=abc123');
    const calls = stubFetch([200]);
    const { get } = await import('./api.js');
    await get('/api/dashboard/x');
    expect(calls[0].url).toBe('/api/dashboard/x');
    expect(String(calls[0].url)).not.toContain('token=');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer abc123');
  });

  it('post() 同时带 Content-Type 与 Authorization', async () => {
    setupEnv('?token=abc123');
    const calls = stubFetch([200]);
    const { post } = await import('./api.js');
    await post('/api/dashboard/y', { a: 1 });
    expect(calls[0].url).toBe('/api/dashboard/y');
    expect(calls[0].opts.headers['Content-Type']).toBe('application/json');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer abc123');
  });

  it('无令牌时不带 Authorization', async () => {
    setupEnv('');
    const calls = stubFetch([200]);
    const { get } = await import('./api.js');
    await get('/api/dashboard/z');
    expect(calls[0].opts.headers.Authorization).toBeUndefined();
  });

  it('图片代理 URL 不带 token（该路由被 auth-guard 无条件豁免，issue #217 审核 ⚠️）', async () => {
    setupEnv('?token=abc123');
    const { imgUrl } = await import('./api.js');
    const out = imgUrl('https://api.vrchat.cloud/api/1/file/fid/1');
    expect(out).toContain('/api/dashboard/image-proxy?url=');
    expect(out).not.toContain('token=');
  });

  it('SSE 仍用 query 形态（EventSource 无法自定义头，属已知例外）', async () => {
    setupEnv('?token=abc123');
    const { sseUrl } = await import('./api.js');
    expect(sseUrl('/api/dashboard/stream')).toBe('/api/dashboard/stream?token=abc123');
  });
});

describe('sseUrl（EventSource 专用，token 走 query）', () => {
  it('无 token 时原样返回', async () => {
    setupEnv('');
    const { sseUrl } = await import('./api.js');
    expect(sseUrl('/api/dashboard/x')).toBe('/api/dashboard/x');
    expect(sseUrl('/api/dashboard/x?a=1')).toBe('/api/dashboard/x?a=1');
  });
  it('URL token 注入（? 与 & 分支）', async () => {
    setupEnv('?token=abc123');
    const { sseUrl } = await import('./api.js');
    expect(sseUrl('/api/dashboard/x')).toBe('/api/dashboard/x?token=abc123');
    expect(sseUrl('/api/dashboard/x?y=1')).toBe('/api/dashboard/x?y=1&token=abc123');
  });
  it('sessionStorage token 兜底 + 回写', async () => {
    setupEnv('');
    globalThis.sessionStorage.setItem('vrc_dashboard_token', 'from-storage');
    const { sseUrl } = await import('./api.js');
    expect(sseUrl('/api/dashboard/x')).toBe('/api/dashboard/x?token=from-storage');
    // URL token 优先于 storage（重新加载模块以读取新环境）
    vi.resetModules();
    setupEnv('?token=from-url');
    const { sseUrl: sseUrl2 } = await import('./api.js');
    expect(sseUrl2('/api/dashboard/x')).toBe('/api/dashboard/x?token=from-url');
  });
});

describe('imgUrl（图片代理白名单）', () => {
  beforeEach(async () => {
    setupEnv('?token=tok');
    const mod = await import('./api.js');
    globalThis.__imgUrl = mod.imgUrl;
  });
  it('VRChat CDN 走代理', () => {
    expect(globalThis.__imgUrl('https://api.vrchat.cloud/api/1/file/abc')).toContain('/api/dashboard/image-proxy?url=');
    expect(globalThis.__imgUrl('https://d348imysud55la.cloudfront.net/x.png')).toContain('/api/dashboard/image-proxy');
    expect(globalThis.__imgUrl('https://files.vrchat.cloud/y')).toContain('image-proxy');
  });
  it('非白名单域名原样返回', () => {
    expect(globalThis.__imgUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(globalThis.__imgUrl('https://i.imgur.com/b.png')).toBe('https://i.imgur.com/b.png');
  });
  it('空/非法 URL 兜底', () => {
    expect(globalThis.__imgUrl('')).toBe('');
    expect(globalThis.__imgUrl(null)).toBe('');
    expect(globalThis.__imgUrl('not-a-url')).toBe('not-a-url');
  });
  it('已是代理 URL 不二次代理', () => {
    expect(globalThis.__imgUrl('/api/dashboard/image-proxy?url=x')).toBe('/api/dashboard/image-proxy?url=x');
  });
});

describe('get/post 错误语义', () => {
  it('401 统一文案（会话过期自愈提示）', async () => {
    setupEnv('');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const { get } = await import('./api.js');
    await expect(get('/api/dashboard/x')).rejects.toThrow('会话过期或服务未就绪');
  });
  it('非 401 报 HTTP 状态码', async () => {
    setupEnv('');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const { get } = await import('./api.js');
    await expect(get('/api/dashboard/x')).rejects.toThrow('HTTP 500');
  });
  it('post 带 JSON body', async () => {
    setupEnv('');
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    globalThis.fetch = mockFetch;
    const { post } = await import('./api.js');
    const r = await post('/api/dashboard/status', { status: 'busy' });
    expect(r).toEqual({ ok: true });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/dashboard/status');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ status: 'busy' });
  });
});

describe('getCached（TTL 缓存）', () => {
  it('60s 内命中缓存不重复请求', async () => {
    setupEnv('');
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: 1 }) });
    globalThis.fetch = mockFetch;
    const { getCached } = await import('./api.js');
    const a = await getCached('/api/dashboard/friends?limit=100');
    const b = await getCached('/api/dashboard/friends?limit=100');
    expect(a).toEqual({ data: 1 });
    expect(b).toEqual({ data: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(1); // 缓存命中——仅一次请求
  });
  it('不同路径各自缓存 + invalidate 清除', async () => {
    setupEnv('');
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ n: ++call }) }));
    const { getCached, invalidateCache } = await import('./api.js');
    await getCached('/a');
    await getCached('/a');
    await getCached('/b');
    expect(call).toBe(2); // /a 命中缓存，/b 新请求
    invalidateCache('/a');
    await getCached('/a');
    expect(call).toBe(3); // 失效后重新请求
  });
});
