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

describe('apiUrl（token 注入）', () => {
  it('无 token 时原样返回', async () => {
    setupEnv('');
    const { apiUrl } = await import('./api.js');
    expect(apiUrl('/api/dashboard/x')).toBe('/api/dashboard/x');
    expect(apiUrl('/api/dashboard/x?a=1')).toBe('/api/dashboard/x?a=1');
  });
  it('URL token 注入（? 与 & 分支）', async () => {
    setupEnv('?token=abc123');
    const { apiUrl } = await import('./api.js');
    expect(apiUrl('/api/dashboard/x')).toBe('/api/dashboard/x?token=abc123');
    expect(apiUrl('/api/dashboard/x?y=1')).toBe('/api/dashboard/x?y=1&token=abc123');
  });
  it('sessionStorage token 兜底 + 回写', async () => {
    setupEnv('');
    globalThis.sessionStorage.setItem('vrc_dashboard_token', 'from-storage');
    const { apiUrl } = await import('./api.js');
    expect(apiUrl('/api/dashboard/x')).toBe('/api/dashboard/x?token=from-storage');
    // URL token 优先于 storage（重新加载模块以读取新环境）
    vi.resetModules();
    setupEnv('?token=from-url');
    const { apiUrl: apiUrl2 } = await import('./api.js');
    expect(apiUrl2('/api/dashboard/x')).toBe('/api/dashboard/x?token=from-url');
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
