// 鉴权门探测单测（issue #213）：未启用鉴权时不得把用户拦在登录页，且令牌判定必须
// 基于 HTTP 状态而不是 /health 的 VRChat 账号态。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const origLocation = globalThis.location;
const origSessionStorage = globalThis.sessionStorage;
const origFetch = globalThis.fetch;

function setupEnv(search = '') {
  globalThis.location = { search, pathname: '/dashboard' };
  const mem = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

/** 记录调用参数的 fetch 替身；每次调用按 statuses 顺序返回一个 Response 样式对象。 */
function stubFetch(statuses) {
  const calls = [];
  const queue = [...statuses];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const status = queue.length ? queue.shift() : 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
    };
  });
  return calls;
}

beforeEach(() => setupEnv(''));

afterEach(() => {
  globalThis.location = origLocation;
  globalThis.sessionStorage = origSessionStorage;
  globalThis.fetch = origFetch;
  vi.resetModules();
});

describe('probeAuthRequired（未启用鉴权时直接放行）', () => {
  it('受保护路由 200 → 不需要令牌', async () => {
    stubFetch([200]);
    const { probeAuthRequired } = await import('./api.js');
    expect(await probeAuthRequired()).toBe(false);
  });

  it('受保护路由 401 → 需要令牌', async () => {
    stubFetch([401]);
    const { probeAuthRequired } = await import('./api.js');
    expect(await probeAuthRequired()).toBe(true);
  });

  it('其它状态码 → 抛错（由调用方保留登录门）', async () => {
    stubFetch([500]);
    const { probeAuthRequired } = await import('./api.js');
    await expect(probeAuthRequired()).rejects.toThrow('HTTP 500');
  });

  it('探测请求不带 token（既不进 URL 也不进 header）', async () => {
    const calls = stubFetch([200]);
    const { probeAuthRequired } = await import('./api.js');
    await probeAuthRequired();
    // 2026-09-22：探针由重数据接口 overview 改为轻量接口 me（用户报登录页仍在请求 overview）
    expect(calls[0].url).toBe('/api/dashboard/me');
    expect(calls[0].url).not.toContain('token=');
    expect(calls[0].opts.headers).toBeUndefined();
  });
});

describe('verifyToken（令牌判定基于 HTTP 状态）', () => {
  it('200 → 令牌有效', async () => {
    const calls = stubFetch([200]);
    const { verifyToken } = await import('./api.js');
    expect(await verifyToken('secret-token')).toBe(true);
    expect(calls[0].opts.headers).toEqual({ Authorization: 'Bearer secret-token' });
    expect(calls[0].url).not.toContain('secret-token');
  });

  it('401 → 令牌无效', async () => {
    stubFetch([401]);
    const { verifyToken } = await import('./api.js');
    expect(await verifyToken('bad')).toBe(false);
  });

  it('非 200/401（服务异常）→ 抛错，不误报「令牌无效」', async () => {
    stubFetch([502]);
    const { verifyToken } = await import('./api.js');
    await expect(verifyToken('t')).rejects.toThrow('HTTP 502');
  });

  it('不读取 /health（VRChat 账号态不得参与面板令牌判定）', async () => {
    const calls = stubFetch([200]);
    const { verifyToken } = await import('./api.js');
    await verifyToken('t');
    expect(calls.every((c) => !c.url.includes('/health'))).toBe(true);
  });
});
