/**
 * VRChat API client — handles auth and API calls
 * 
 * Auth lifecycle:
 * 1. Load cookie from file → validate with /auth/user
 * 2. If cookie expired → auto-attempt Basic auth login (email+password)
 * 3. If Basic auth needs 2FA → save temp cookie, signal "need OTP"
 * 4. User provides OTP via submitOtp() → complete login, save new cookie
 * 5. Proactive cookie refresh via heartbeat endpoint
 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { recordOpsLog } from './core/ops-log.js';
import { getLogger } from './core/logger.js';

const API_BASE = 'https://api.vrchat.cloud/api/1';

// 单个 VRChat API 请求的 socket 超时（毫秒）。正常请求 1-3s 返回，
// 网络抖动/代理失效时若不加超时，挂起的请求会锁死 rateLimiter 队列。
const REQUEST_TIMEOUT_MS = 15000;

// 慢调用阈值（毫秒，代码常量不走 env）：成功但耗时超过该值 → 升格 INFO 可见
const API_SLOW_MS = 2000;

// 统计有界：失败路径聚合表条数上限 / 耗时采样环形缓冲容量（长跑不涨内存）
const MAX_FAIL_MAP = 300;
const MAX_DURATION_SAMPLES = 512;

// 命名日志：API 组件标签
const log = getLogger('api');

// 允许的覆盖：https 任意主机（自建 staging 等）、回环 http（本地测试 stub）。
// ⚠️ 非回环 http 一律忽略并 WARN 留痕——明文网关会泄露 auth cookie / 凭据，禁止静默接受。
// 按「原始字符串」记忆化解析结果：env 中途变更（测试）也能即时生效。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
let apiBaseCache = { raw: null, base: API_BASE };

/**
 * 解析 API 基址覆盖（纯函数，便于测试）：仅接受 https 或回环 http，其它一律拒绝。
 * @param {string|undefined} raw VRC_MONITOR_API_BASE 原始值
 * @param {(msg:string)=>void} [onWarn] 拒绝时的留痕回调（禁静默）
 * @returns {string} 生效基址（拒绝时返回生产默认 API_BASE）
 */
export function resolveApiBase(raw, onWarn) {
  if (!raw) return API_BASE;
  const warn = typeof onWarn === 'function' ? onWarn : (m) => log.warn(m);
  try {
    const u = new URL(raw);
    const isLoopback = LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
    if (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback)) {
      return raw.replace(/\/+$/, '');
    }
    warn(
      `VRC_MONITOR_API_BASE 覆盖被忽略（仅允许 https 或回环 http）: ${u.protocol}//${u.host}` +
      ` —— 继续使用 ${API_BASE}`
    );
  } catch {
    warn(`VRC_MONITOR_API_BASE 不是合法 URL，已忽略: ${String(raw).slice(0, 80)}`);
  }
  return API_BASE;
}

function apiBase() {
  const raw = process.env.VRC_MONITOR_API_BASE;
  if (apiBaseCache.raw === raw) return apiBaseCache.base;
  const base = resolveApiBase(raw);
  apiBaseCache = { raw, base };
  return base;
}

// 请求超时运行时读取：VRC_MONITOR_API_TIMEOUT_MS 为测试开关（生产默认 15000ms）
function requestTimeoutMs() {
  const v = parseInt(process.env.VRC_MONITOR_API_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : REQUEST_TIMEOUT_MS;
}

// 按 URL 协议选择请求模块：生产 https；测试 stub 可用 http://
function pickRequestLib(url) {
  return url.protocol === 'http:' ? http : https;
}

// 路径归一化：ID 段（usr_/grp_/wrld_/avtr_/file_/pmod_/not_ 前缀）→ :id；查询串剥离（日志不落 query）
const ID_SEGMENT_RE = /^(usr_|grp_|wrld_|avtr_|file_|pmod_|not_)/;
export function normalizeApiPath(path) {
  return String(path).split('?')[0].split('/').map((seg) => {
    if (seg && ID_SEGMENT_RE.test(seg)) return ':id';
    return seg;
  }).join('/');
}

export class VrchatApiClient {
  /** @type {Promise|null} single-flight lock for ensureAuth / ensureAuthWithAutoOtp */
  #authLock = null;

  constructor(email, password) {
    this.email = email;
    this.password = password;
    this.authCookie = '';
    this.currentUser = null;
    this.requiresOtp = false;       // true after Basic auth when 2FA needed
    this.tempAuthCookie = '';       // partial cookie before 2FA verify
    this.pending2faTypes = [];      // 2FA types required by the pending login (e.g. ['emailOtp','totp'])
    this._cookiePath = '';
    this.#authLock = null;       // single-flight lock for ensureAuth / ensureAuthWithAutoOtp
    this.otpFetcher = null;        // 注入邮箱 OTP 自动获取函数（用于 401 自动重认证）
    this.totpFetcher = null;       // 注入 TOTP 验证码自动生成函数（credentials.json 配置 totp_secret 后启用）
    this._reauthInFlight = false;  // 防止并发 401 重认证
    this._reauthCooldownUntil = 0; // 非 TOTP 重认证失败后的冷却（防循环）
    // 外部调用可观测性统计（有界累积，快照见 getApiStats）
    this._apiStats = {
      total: 0, ok: 0, failed: 0, timeouts: 0, slow: 0,
      byStatus: {}, failMap: new Map(), lastFailure: null,
      durationMsSum: 0, durations: [],
    };
    this._reauthAttempt = 0;       // 当前 401 自动重认证连续尝试计数（成功归零）
  }

  /** 注入邮箱 OTP 获取函数（start-monitor.js 启动时调用） */
  setOtpFetcher(fn) {
    this.otpFetcher = fn;
  }

  /** 注入 TOTP 验证码自动生成函数（配置 totp_secret 后启用自动登录） */
  setTotpFetcher(fn) {
    this.totpFetcher = fn;
  }

  loadCookieFromFile(path) {
    this._cookiePath = path;
    if (existsSync(path)) {
      this.authCookie = readFileSync(path, 'utf-8').trim();
      return !!this.authCookie;
    }
    return false;
  }

  saveCookieToFile(path) {
    this._cookiePath = path || this._cookiePath;
    if (this._cookiePath) {
      writeFileSync(this._cookiePath, this.authCookie);
    }
  }

  /**
   * Make an HTTPS request with cookie.
   *
   * 带 401 自动重认证：业务请求返回 401（cookie 过期）时自动尝试重新登录，
   * 成功后重放原请求一次；若重新登录需要 TOTP，则抛 { needsTotp: true } 进入
   * needsTotp 状态（tempAuthCookie 已保留，submit_totp 可直接完成登录）。
   *
   * 注意：认证端点自身（/auth/user、/auth、twofactorauth）不走此逻辑，
   * 避免 ensureAuth / checkAuth 内部形成递归。
   */
  async _request(method, path, body = null, customCookies = null) {
    const startedAt = Date.now();
    let res;
    try {
      res = await this._requestRaw(method, path, body, customCookies);
    } catch (err) {
      this._recordApiResult(method, path, { error: err, durationMs: Date.now() - startedAt });
      throw err;
    }
    if (res.status === 401 && !customCookies && !this._isAuthEndpoint(path)) {
      // 首次 401 是真实失败请求：先留痕，再尝试自动重认证并重放
      this._recordApiResult(method, path, { status: 401, durationMs: Date.now() - startedAt });
      try {
        const reauthed = await this._tryAutoReauth();
        if (reauthed) {
          const replayAt = Date.now();
          let replayed;
          try {
            replayed = await this._requestRaw(method, path, body, customCookies);
          } catch (err) {
            this._recordApiResult(method, path, { error: err, durationMs: Date.now() - replayAt });
            throw err;
          }
          this._recordApiResult(method, path, { status: replayed.status, durationMs: Date.now() - replayAt });
          return replayed;
        }
      } catch (err) {
        if (err.needsTotp) {
          // 保留 tempAuthCookie，抛 needsTotp 由 registry.dispatch 设置 serverState.needsTotp
          err.message = `API 登录已失效，需要 TOTP 验证码：请调用 submit_totp 提交当前验证码（${err.message}）`;
          throw err;
        }
        // 其他重认证错误：不吞掉，向上抛
        throw err;
      }
    }
    this._recordApiResult(method, path, { status: res.status, durationMs: Date.now() - startedAt });
    return res;
  }

  /** 认证端点判断——避免 ensureAuth/checkAuth 内部递归触发重认证 */
  _isAuthEndpoint(path) {
    return path === '/auth' || path === '/auth/user' || path.startsWith('/auth/twofactorauth');
  }

  /**
   * R1：唯一留痕漏斗——每次 _request 的计时与结果分级（日志 + 统计）。
   * 绝不抛错 / 不改返回结构 / 不额外耗时（纯内存操作 + 无 sink 时 ops_log 为 no-op）。
   */
  _recordApiResult(method, path, { status = null, error = null, durationMs = 0 }) {
    const s = this._apiStats;
    s.total++;
    if (s.durations.length >= MAX_DURATION_SAMPLES) {
      s.durationMsSum -= s.durations.shift();
    }
    s.durations.push(durationMs);
    s.durationMsSum += durationMs;

    const p = normalizeApiPath(path);

    if (error) {
      const reason = String(error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 200);
      s.failed++;
      if (/超时|timeout/i.test(reason)) {
        s.timeouts++;
        s.lastFailure = `[timeout] ${method} ${p}`;
        this._bumpFail(p, 'timeout');
        const line = `${method} ${p} 超时（${durationMs}ms）`;
        log.warn(line);
        recordOpsLog('api', 'warn', `[api] ${line}`);
      } else {
        s.lastFailure = `${method} ${p}（${reason}）`;
        this._bumpFail(p, 'error');
        const line = `${method} ${p} 请求失败: ${reason}（耗时 ${durationMs}ms）`;
        log.warn(line);
        recordOpsLog('api', 'warn', `[api] ${line}`);
      }
      return;
    }

    s.byStatus[status] = (s.byStatus[status] || 0) + 1;
    if (status >= 200 && status < 300) {
      s.ok++;
      if (durationMs > API_SLOW_MS) {
        s.slow++;
        log.info(`${method} ${p} → ${status}（${durationMs}ms 慢调用）`);
      } else if (process.env.VRC_MONITOR_LOG_API_SUCCESS === '1') {
        log.info(`${method} ${p} → ${status}（${durationMs}ms）`);
      } else {
        log.debug(`${method} ${p} → ${status}（${durationMs}ms）`);
      }
    } else {
      s.failed++;
      s.lastFailure = `${method} ${p} → HTTP ${status}`;
      this._bumpFail(p, `HTTP ${status}`);
      const line = `${method} ${p} → ${status}（${durationMs}ms）`;
      log.warn(line);
      recordOpsLog('api', 'warn', `[api] ${line}`);
    }
  }

  /** 失败路径聚合（有界：超过 MAX_FAIL_MAP 时逐出计数最小项） */
  _bumpFail(normPath, tag) {
    const map = this._apiStats.failMap;
    const entry = map.get(normPath) || { count: 0, last: '' };
    entry.count += 1;
    entry.last = tag;
    map.set(normPath, entry);
    if (map.size > MAX_FAIL_MAP) {
      let minKey = null;
      let minCount = Infinity;
      for (const [k, v] of map) {
        if (v.count < minCount) { minCount = v.count; minKey = k; }
      }
      map.delete(minKey);
    }
  }

  /** R1：API 调用统计快照（/health 暴露用；有界累积，长跑不涨内存） */
  getApiStats() {
    const s = this._apiStats;
    const durs = s.durations;
    let p95Ms = null;
    if (durs.length > 0) {
      const sorted = [...durs].sort((a, b) => a - b);
      p95Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }
    const topFailures = [...s.failMap.entries()]
      .map(([p, v]) => ({ path: p, count: v.count, last: v.last }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    return {
      total: s.total,
      ok: s.ok,
      failed: s.failed,
      timeouts: s.timeouts,
      slow: s.slow,
      byStatus: { ...s.byStatus },
      topFailures,
      lastFailure: s.lastFailure,
      avgMs: durs.length > 0 ? Math.round(s.durationMsSum / durs.length) : null,
      p95Ms,
    };
  }

  /**
   * 401 后的自动重认证（single-flight + 冷却）。
   * 返回 true=已重新登录；false=失败已冷却；抛 { needsTotp } = 需 TOTP 手动提交。
   */
  async _tryAutoReauth() {
    if (this._reauthInFlight) return false;  // 已有重认证进行中，跳过本次
    if (Date.now() < this._reauthCooldownUntil) return false;

    this._reauthInFlight = true;
    this._reauthAttempt++;
    log.info(`触发自动重认证（第 ${this._reauthAttempt} 次）`);
    try {
      log.info('[警告] 请求返回 401，尝试自动重新登录...');
      if (this.otpFetcher || this.totpFetcher) {
        await this.ensureAuthWithAutoOtp(this.otpFetcher);
      } else {
        // 无 otpFetcher（如测试/未注入场景）：仍解析 2FA 类型，
        // 纯 TOTP 账号应进入 needsTotp 而非笼统 needsOtp
        try {
          await this.ensureAuth();
        } catch (err) {
          if (err.needsOtp) {
            const types = this.pending2faTypes || [];
            if (types.includes('totp')) {
              const totpErr = new Error('账号启用 TOTP 两步验证，请调用 submit_totp 工具提交当前验证码');
              totpErr.needsTotp = true;
              throw totpErr;
            }
            this.requiresOtp = false;
            this.tempAuthCookie = '';
          }
          throw err;
        }
      }
      log.info('[成功] 自动重新登录成功');
      this._reauthAttempt = 0;
      return true;
    } catch (err) {
      if (err.needsTotp) throw err;
      // 非 TOTP 失败（网络/凭据错误等）：冷却 60s，避免高频重试
      this._reauthCooldownUntil = Date.now() + 60_000;
      log.warn(`[失败] 自动重新登录失败: ${err.message}`);
      return false;
    } finally {
      this._reauthInFlight = false;
    }
  }

  /** 底层原始请求（无 401 自动重认证逻辑） */
  _requestRaw(method, path, body = null, customCookies = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(apiBase() + path);
      const lib = pickRequestLib(url);
      const cookieStr = customCookies || (this.authCookie ? `auth=${this.authCookie}` : '');

      const options = {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method,
        headers: {
          'User-Agent': 'VRCX-0-Actions-MCP/1.0',
          'Accept': 'application/json',
          ...(cookieStr ? { 'Cookie': cookieStr } : {}),
        },
      };

      if (body) {
        options.headers['Content-Type'] = 'application/json';
      }

      const req = lib.request(options, (res) => {
        let chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed, headers: res.headers });
          } catch {
            resolve({ status: res.statusCode, data, headers: res.headers });
          }
        });
      });

      // 超时兜底：socket 半通不通（网络抖动/代理失效）时请求可能永挂不返回，
      // 若不设超时会占住 rateLimiter 队头 -> 锁死整条队列；超时 destroy 触发 error -> reject。
      // [警告] 注：Node req.setTimeout 是「socket 空闲超时」(idle timeout)——仅在 socket 无任何
      //    活动时触发；「持续小流量但永不 end」的响应不会被它覆盖（由 rateLimiter 的
      //    任务级超时兜底，见 core/rate-limiter.js）。
      req.setTimeout(requestTimeoutMs(), () => {
        req.destroy(new Error(`VRChat API 请求超时 (${requestTimeoutMs()}ms): ${method} ${path}`));
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * If VRChat API accepted a basic auth login but still wants 2FA,
   * the `authCookie` variable still gets set to a valid temp cookie
   * that we need to send alongside the OTP verification request.
   * 
   * Full login flow: Basic auth → 2FA verify → get user info
   *
   * @param {string} code 6-digit verification code (email OTP or TOTP)
   * @param {string} type 'emailOtp' | 'totp'
   */
  async _verify2fa(code, type) {
    if (!this.tempAuthCookie) throw new Error('No pending 2FA session. Call tryLoginWithCredentials() first.');

    const otpCookieStr = `auth=${this.tempAuthCookie}`;
    const endpoint = type === 'totp'
      ? '/auth/twofactorauth/totp/verify'
      : '/auth/twofactorauth/emailotp/verify';

    // Step 2: Verify code
    const r2 = await this._rawRequest('POST', endpoint,
      { code }, otpCookieStr);
    if (r2.status !== 200) {
      throw new Error(`2FA 验证失败 (HTTP ${r2.status})`);
    }

    // Extract the REAL auth cookie from verify response Set-Cookie header.
    // VRChat may not re-send the cookie here — it can upgrade the temp
    // session in place, so keep the existing (now-upgraded) authCookie.
    const cookies = this._extractCookies(r2.headers);
    if (cookies.auth) {
      this.authCookie = cookies.auth;
    }

    // Step 3: Get user with the auth cookie
    const r3 = await this._request('GET', '/auth/user');
    if (r3.status !== 200 || !r3.data?.id) {
      throw new Error(`2FA 登录后获取用户信息失败 (HTTP ${r3.status})`);
    }

    this.currentUser = r3.data;
    this.requiresOtp = false;
    this.tempAuthCookie = '';
    this.pending2faTypes = [];
    this.saveCookieToFile();
    return this.currentUser;
  }

  /** 邮箱 OTP 登录（兼容旧调用） */
  async loginWithOtp(otpCode) {
    return this._verify2fa(otpCode, 'emailOtp');
  }

  /** TOTP（Authenticator 应用验证码）登录 */
  async loginWithTotp(totpCode) {
    return this._verify2fa(totpCode, 'totp');
  }

  /**
   * Attempt to login with email+password credentials.
   * Uses proper Authorization: Basic header for the initial auth request.
   * Returns { success: true, user } if no 2FA needed.
   * Returns { requiresOtp: true } if 2FA needed.
   * Throws on failure.
   */
  async tryLoginWithCredentials() {
    const basic = Buffer.from(`${this.email}:${this.password}`).toString('base64');

    // Use _rawRequest for Basic auth (proper Authorization header, not Cookie)
    const r1 = await this._basicAuthRequest('GET', '/auth/user', basic);
    const cookies = this._extractCookies(r1.headers);

    if (!cookies.auth) {
      const isLimited = r1.status === 401;
      console.error(`[VRChat API] [失败] Login failed. Status: ${r1.status}${isLimited ? ' [限流?]' : ''}, Body: ${JSON.stringify(r1.data).slice(0, 200)}`);
      const err = new Error('No auth cookie from login — check credentials or account status');
      if (isLimited) err.isRateLimited = true;
      throw err;
    }

    // Save the auth cookie regardless — it may be a temp cookie
    this.authCookie = cookies.auth;

    if (r1.data?.requiresTwoFactorAuth) {
      // 2FA required — save the temp cookie for 2FA step
      this.requiresOtp = true;
      this.tempAuthCookie = cookies.auth;
      // VRChat 返回数组如 ['emailOtp','totp']；旧格式布尔 true 兜底为 emailOtp
      this.pending2faTypes = Array.isArray(r1.data.requiresTwoFactorAuth)
        ? r1.data.requiresTwoFactorAuth
        : ['emailOtp'];
      return {
        requiresOtp: true,
        twoFactorAuthTypes: this.pending2faTypes,
        message: '2FA required. Please provide the verification code.',
      };
    }

    // Success — no 2FA needed
    this.currentUser = r1.data;
    this.requiresOtp = false;
    this.tempAuthCookie = '';
    this.pending2faTypes = [];
    this.saveCookieToFile();
    return { success: true, user: r1.data };
  }

  /**
   * Make a request with Authorization: Basic header (for initial login)
   */
  async _basicAuthRequest(method, path, basicToken) {
    return new Promise((resolve, reject) => {
      const url = new URL(apiBase() + path);
      const lib = pickRequestLib(url);
      const options = {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method,
        headers: {
          'User-Agent': 'VRCX-0-Actions-MCP/1.0',
          'Accept': 'application/json',
          'Authorization': `Basic ${basicToken}`,
        },
      };
      const req = lib.request(options, (res) => {
        let chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed, headers: res.headers });
          } catch {
            resolve({ status: res.statusCode, data, headers: res.headers });
          }
        });
      });
      // 超时兜底：socket 半通不通（网络抖动/代理失效）时请求可能永挂不返回，
      // 若不设超时会占住 rateLimiter 队头 -> 锁死整条队列；超时 destroy 触发 error -> reject。
      // [警告] 注：Node req.setTimeout 是「socket 空闲超时」(idle timeout)——仅在 socket 无任何
      //    活动时触发；「持续小流量但永不 end」的响应不会被它覆盖（由 rateLimiter 的
      //    任务级超时兜底，见 core/rate-limiter.js）。
      req.setTimeout(requestTimeoutMs(), () => {
        req.destroy(new Error(`VRChat API 请求超时 (${requestTimeoutMs()}ms): ${method} ${path}`));
      });

      req.on('error', reject);
      req.end();
    });
  }

  _extractCookies(headers) {
    const result = {};
    const setCookie = headers['set-cookie'];
    if (setCookie) {
      for (const c of Array.isArray(setCookie) ? setCookie : [setCookie]) {
        const m = c.split(';')[0].match(/^([^=]+)=(.*)/);
        if (m) result[m[1]] = m[2];
      }
    }
    return result;
  }

  async _rawRequest(method, path, body, cookieStr) {
    return new Promise((resolve, reject) => {
      const url = new URL(apiBase() + path);
      const lib = pickRequestLib(url);
      const options = {
        hostname: url.hostname, port: url.port || undefined, path: url.pathname, method,
        headers: {
          'User-Agent': 'VRCX-0-Actions-MCP/1.0',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(cookieStr ? { 'Cookie': cookieStr } : {}),
        },
      };
      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      });
      // 超时兜底：socket 半通不通（网络抖动/代理失效）时请求可能永挂不返回，
      // 若不设超时会占住 rateLimiter 队头 -> 锁死整条队列；超时 destroy 触发 error -> reject。
      // [警告] 注：Node req.setTimeout 是「socket 空闲超时」(idle timeout)——仅在 socket 无任何
      //    活动时触发；「持续小流量但永不 end」的响应不会被它覆盖（由 rateLimiter 的
      //    任务级超时兜底，见 core/rate-limiter.js）。
      req.setTimeout(requestTimeoutMs(), () => {
        req.destroy(new Error(`VRChat API 请求超时 (${requestTimeoutMs()}ms): ${method} ${path}`));
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Ensure logged in. Auto-tries credential re-login if cookie is expired.
   * Single-flight: concurrent callers wait for the same auth attempt.
   * Returns current user data on success.
   * Throws { needsOtp: true } if re-login requires 2FA.
   */
  async ensureAuth() {
    if (this.#authLock) return this.#authLock;
    this.#authLock = this._doEnsureAuth();
    const t0 = Date.now();
    try {
      const user = await this.#authLock;
      recordOpsLog('auth', 'info', '认证完成：会话有效（' + (Date.now() - t0) + 'ms）');
      return user;
    } catch (err) {
      const why = err.needsOtp ? '需要 2FA 验证码' : (err.message || '未知错误');
      recordOpsLog('auth', 'warn', '认证失败（' + (Date.now() - t0) + 'ms）：' + why);
      throw err;
    } finally {
      this.#authLock = null;
    }
  }

  async _doEnsureAuth() {
    // If we already know we need 2FA, throw needsOtp signal
    if (this.requiresOtp) {
      const err = new Error('Auth requires 2FA verification.');
      err.needsOtp = true;
      throw err;
    }

    if (!this.authCookie) {
      // No cookie at all — try fresh login
      const result = await this.tryLoginWithCredentials();
      if (result.requiresOtp) {
        const err = new Error(result.message);
        err.needsOtp = true;
        throw err;
      }
      return result.user;
    }

    // Validate existing cookie
    const r = await this._request('GET', '/auth/user');
    if (r.status === 200 && r.data?.id) {
      // Cookie valid — update from Set-Cookie headers (VRChat extends expiry on use)
      const cookies = this._extractCookies(r.headers);
      if (cookies.auth) {
        this.authCookie = cookies.auth;
        this.saveCookieToFile();
      }
      this.currentUser = r.data;
      return r.data;
    }

    // Cookie expired — try re-login
    console.log('[VRChat API] [警告] Auth cookie expired, attempting re-login...');
    const result = await this.tryLoginWithCredentials();
    if (result.requiresOtp) {
      const err = new Error(result.message);
      err.needsOtp = true;
      throw err;
    }
    return result.user;
  }

  /**
   * Ensure authenticated, auto-fetching OTP from email if needed.
   * Single-flight: concurrent callers wait for the same auth attempt.
   * @param {Function} otpFetcher - async function that returns 6-digit OTP code
   * @returns {Object} current user data
   */
  async ensureAuthWithAutoOtp(otpFetcher) {
    if (this.#authLock) return this.#authLock;
    this.#authLock = this._doEnsureAuthWithAutoOtp(otpFetcher);
    const t0 = Date.now();
    try {
      const user = await this.#authLock;
      recordOpsLog('auth', 'info', '\u81ea\u52a8\u8ba4\u8bc1\u6210\u529f\uff082FA \u5df2\u81ea\u52a8\u5b8c\u6210\uff0c\u4f1a\u8bdd\u6709\u6548\uff0c' + (Date.now() - t0) + 'ms\uff09');
      return user;
    } catch (err) {
      const why = err.needsTotp
        ? '\u9700\u8981\u624b\u52a8\u63d0\u4ea4 TOTP\uff08\u8c03\u7528 submit_totp\uff09'
        : err.needsOtp
          ? '\u9700\u8981 2FA \u9a8c\u8bc1\u7801\u4e14\u81ea\u52a8\u83b7\u53d6\u5931\u8d25'
          : (err.message || '\u672a\u77e5\u9519\u8bef');
      recordOpsLog('auth', 'warn', '\u81ea\u52a8\u8ba4\u8bc1\u5931\u8d25\uff08' + (Date.now() - t0) + 'ms\uff09\uff1a' + why);
      throw err;
    } finally {
      this.#authLock = null;
    }
  }

  /** 自动生成并提交 TOTP 验证码完成登录；失败抛错（无 needsTotp 标记，由调用方决定是否转手动） */
  async _autoTotpLogin() {
    if (!this.totpFetcher) throw new Error('未配置 TOTP fetcher');
    // totpFetcher 返回单个验证码或数组（[前窗口, 当前, 后窗口] 容错时钟漂移，审核 #70 🟡 建议 2）
    const codes = await this.totpFetcher();
    const candidates = Array.isArray(codes) ? codes : [codes];
    let lastErr = null;
    for (const code of candidates) {
      if (!code || !/^\d{6,8}$/.test(String(code))) {
        lastErr = new Error(`无效的 TOTP 验证码: "${code}"`);
        continue;
      }
      try {
        return await this.loginWithTotp(String(code));
      } catch (err) {
        lastErr = err; // 该窗口验证码被拒，尝试下一窗口
      }
    }
    throw lastErr || new Error('无可用 TOTP 验证码');
  }

  async _doEnsureAuthWithAutoOtp(otpFetcher) {
    try {
      return await this._doEnsureAuth();
    } catch (err) {
      if (!err.needsOtp) throw err;

      // 根据账号启用的 2FA 类型分流：含 emailOtp 优先邮箱自动抓取；
      // 仅 totp 时若配置了 totp_secret 则自动生成验证码，否则转 submit_totp 手动提交
      const types = this.pending2faTypes || [];
      const needEmailOtp = types.includes('emailOtp');
      const needTotp = types.includes('totp');

      if (needEmailOtp) {
        console.log('[VRChat API] [警告] 需要邮箱验证码，自动获取中...');
        try {
          const otpCode = await otpFetcher();
          if (!otpCode || !/^\d{6}$/.test(String(otpCode))) {
            throw new Error(`无效的验证码: "${otpCode}"，应为6位数字`);
          }
          return await this.loginWithOtp(String(otpCode));
        } catch (otpErr) {
          // 邮箱抓取失败：若账号也支持 TOTP，先试自动 TOTP 兜底，再转手动提交（保留 tempAuthCookie）
          if (needTotp) {
            if (this.totpFetcher) {
              console.log('[VRChat API] [警告] 邮箱验证码获取失败，尝试自动 TOTP 兜底...');
              try {
                const user = await this._autoTotpLogin();
                console.log('[VRChat API] [成功] 自动 TOTP 兜底登录成功');
                return user;
              } catch (totpErr) {
                // 邮箱与自动 TOTP 双失败：补冷却等待下个窗口（与仅 TOTP 分支对称，审核 #70 🟡 建议 1）
                this._reauthCooldownUntil = Date.now() + 30_000;
                const totpErr2 = new Error(`邮箱与自动 TOTP 均失败(${totpErr.message})，请调用 submit_totp 工具提交验证码`);
                totpErr2.needsTotp = true;
                totpErr2.needsOtp = true;
                throw totpErr2;
              }
            }
            const totpErr = new Error(`邮箱验证码获取失败(${otpErr.message})，请调用 submit_totp 工具提交 TOTP 验证码`);
            totpErr.needsTotp = true;
            totpErr.needsOtp = true;
            throw totpErr;
          }
          this.requiresOtp = false;
          this.tempAuthCookie = '';
          throw new Error(`OTP 自动登录失败: ${otpErr.message}`);
        }
      }

      if (needTotp) {
        if (this.totpFetcher) {
          console.log('[VRChat API] [警告] 需要 TOTP 验证码，自动生成中...');
          try {
            const user = await this._autoTotpLogin();
            console.log('[VRChat API] [成功] TOTP 自动登录成功');
            return user;
          } catch (totpErr) {
            // 自动失败：保留 tempAuthCookie 转手动 submit_totp 兜底；冷却等待下一个 TOTP 窗口再自动重试
            this._reauthCooldownUntil = Date.now() + 30_000;
            const totpErr2 = new Error(`TOTP 自动登录失败(${totpErr.message})，请调用 submit_totp 工具提交当前验证码或检查 totp_secret`);
            totpErr2.needsTotp = true;
            totpErr2.needsOtp = true;
            throw totpErr2;
          }
        }
        // 未配置 totp_secret：保留 tempAuthCookie，等待 submit_totp 工具提交验证码
        const totpErr = new Error('账号启用 TOTP 两步验证，请调用 submit_totp 工具提交当前验证码（或在 credentials.json 配置 totp_secret 启用自动登录）');
        totpErr.needsTotp = true;
        totpErr.needsOtp = true;
        throw totpErr;
      }

      // 未知 2FA 类型：按邮箱处理兜底
      try {
        const otpCode = await otpFetcher();
        if (!otpCode || !/^\d{6}$/.test(String(otpCode))) {
          throw new Error(`无效的验证码: "${otpCode}"，应为6位数字`);
        }
        return await this.loginWithOtp(String(otpCode));
      } catch (otpErr) {
        this.requiresOtp = false;
        this.tempAuthCookie = '';
        throw new Error(`OTP 自动登录失败: ${otpErr.message}`);
      }
    }
  }

  /**
   * Quick health check — validates cookie without side effects.
   * Returns { valid: true, user } or { valid: false }.
   */
  async checkAuth() {
    if (!this.authCookie) return { valid: false };
    try {
      const r = await this._request('GET', '/auth/user');
      if (r.status === 200 && r.data?.id) {
        // Update cookie from response headers (extends lifespan)
        const cookies = this._extractCookies(r.headers);
        if (cookies.auth) {
          this.authCookie = cookies.auth;
          this.saveCookieToFile();
        }
        return { valid: true, user: r.data, displayName: r.data.displayName };
      }
      return { valid: false };
    } catch {
      return { valid: false };
    }
  }

  /**
   * Send a boop (poke) to a user
   */
  async sendBoop(userId, emojiId = '') {
    const user = await this.ensureAuth();
    return await this._request('POST', `/users/${encodeURIComponent(userId)}/boop`,
      emojiId ? { emojiId } : {});
  }

  /**
   * Invite a user to your instance
   */
  async sendInvite(userId, worldId, instanceId, message = '') {
    await this.ensureAuth();
    // VRChat API expects combined instanceId format: "worldId:instanceDetails"
    const inviteBody = { instanceId: `${worldId}:${instanceId}` };
    if (message) inviteBody.message = message;
    return await this._request('POST', `/invite/${encodeURIComponent(userId)}`, inviteBody);
  }

  /**
   * Request invite from a user
   */
  async requestInvite(userId, message = '') {
    await this.ensureAuth();
    return await this._request('POST', `/requestInvite/${encodeURIComponent(userId)}`, {
      message: message || 'Can I join you?', platform: 'standalonewindows',
    });
  }

  /**
   * Send a friend request to a user
   */
  async sendFriendRequest(userId) {
    await this.ensureAuth();
    return await this._request('POST', `/user/${encodeURIComponent(userId)}/friendRequest`, {});
  }

  /**
   * Remove a friend
   */
  async removeFriend(userId) {
    await this.ensureAuth();
    return await this._request('DELETE', `/auth/user/friends/${encodeURIComponent(userId)}`);
  }

  /**
   * Get user info
   */
  async getUser(userId) {
    await this.ensureAuth();
    return await this._request('GET', `/users/${encodeURIComponent(userId)}`);
  }

  /**
   * Upload an image file via multipart/form-data (used for custom emojis)
   */
  async uploadImageFile(fileBuffer, filename, params) {
    await this.ensureAuth();
    // 显式 contentType: image/png（默认 fileDisplayName 'blob' 无扩展名 → octet-stream → 服务端 400 "must be an image"）
    return this._multipartRequest('POST', '/file/image', fileBuffer, filename, params, { fileFieldName: 'file', fileDisplayName: 'blob', contentType: 'image/png' });
  }

  /**
   * Upload a photo to VRChat Plus prints album
   */
  async uploadPrint(fileBuffer, filename, { note = '', timestamp } = {}) {
    await this.ensureAuth();
    return this._multipartRequest('POST', '/prints', fileBuffer, filename, { note, timestamp }, { fileFieldName: 'image', fileDisplayName: 'image', contentType: 'image/png' });
  }

  /**
   * Upload an image to VRChat Plus gallery
   */
  async uploadGalleryImage(fileBuffer, filename) {
    await this.ensureAuth();
    // 文件字段名 "file"/"blob"；显式指定 image/png（blob 无扩展名会被识别为 octet-stream 导致服务端拒收）
    return this._multipartRequest('POST', '/file/image', fileBuffer, filename, { tag: 'gallery' }, { fileFieldName: 'file', fileDisplayName: 'blob', contentType: 'image/png' });
  }

  _multipartRequest(method, path, fileBuffer, filename, params, { fileFieldName = 'file', fileDisplayName = 'blob', contentType } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(apiBase() + path);
      const lib = pickRequestLib(url);
      const boundary = `----VrcMonitorBoundary${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const cookieStr = this.authCookie ? `auth=${this.authCookie}` : '';
      const fieldName = fileFieldName || 'file';
      const displayName = fileDisplayName || 'blob';

      // VRChat /file/image 期望每个 JSON 参数作为独立 multipart 字段（VRCX BuildImageUploadRequest 实测）
      // 文件字段名/文件名可配置，默认 "file"/"blob"
      const parts = [];
      for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null) continue;
        parts.push(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${key}"\r\n` +
          `\r\n${value}\r\n`
        );
      }
      const ct = contentType || this._guessContentType(displayName);
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${displayName}"\r\n` +
        `Content-Type: ${ct}\r\n\r\n`
      );
      const pre = Buffer.from(parts.join(''));
      const post = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([pre, fileBuffer, post]);

      const options = {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method,
        headers: {
          'User-Agent': 'VRCX-0-Actions-MCP/1.0',
          'Accept': 'application/json',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          ...(cookieStr ? { 'Cookie': cookieStr } : {}),
        },
      };

      const req = lib.request(options, (res) => {
        let chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed, headers: res.headers });
          } catch {
            resolve({ status: res.statusCode, data, headers: res.headers });
          }
        });
      });

      // 超时兜底：socket 半通不通（网络抖动/代理失效）时请求可能永挂不返回，
      // 若不设超时会占住 rateLimiter 队头 -> 锁死整条队列；超时 destroy 触发 error -> reject。
      // [警告] 注：Node req.setTimeout 是「socket 空闲超时」(idle timeout)——仅在 socket 无任何
      //    活动时触发；「持续小流量但永不 end」的响应不会被它覆盖（由 rateLimiter 的
      //    任务级超时兜底，见 core/rate-limiter.js）。
      req.setTimeout(requestTimeoutMs(), () => {
        req.destroy(new Error(`VRChat API 请求超时 (${requestTimeoutMs()}ms): ${method} ${path}`));
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _guessContentType(filename) {
    if (!filename) return 'application/octet-stream';
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
    };
    return map[ext] || 'application/octet-stream';
  }

  /**
   * Download a binary file (VRChat file endpoints require Cookie + UA, otherwise 403)
   * @param {string} url Full URL (e.g. https://api.vrchat.cloud/api/1/file/xxx/1/file)
   * @returns {Promise<Buffer>}
   */
  async downloadFile(url) {
    await this.ensureAuth();
    return this._downloadWithRedirects(url, 0);
  }

  _downloadWithRedirects(url, redirectCount) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const lib = pickRequestLib(target);
      const options = {
        hostname: target.hostname,
        port: target.port || undefined,
        path: target.pathname + target.search,
        method: 'GET',
        headers: {
          'User-Agent': 'VRCX-0-Actions-MCP/1.0',
          'Cookie': `auth=${this.authCookie}`,
        },
      };

      const req = lib.request(options, (res) => {
        // 302/301 重定向（VRChat 文件 URL → files.vrchat.cloud CDN 签名 URL）
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectCount >= 5) {
            reject(new Error(`重定向次数过多 (${url})`));
            return;
          }
          // 相对/绝对 location 解析
          const next = new URL(res.headers.location, url).toString();
          res.resume(); // 释放连接
          resolve(this._downloadWithRedirects(next, redirectCount + 1));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`下载失败 HTTP ${res.statusCode}`));
            return;
          }
          const buffer = Buffer.concat(chunks);
          buffer.contentType = res.headers['content-type'] || null;
          resolve(buffer);
        });
      });

      // 超时兜底：socket 半通不通（网络抖动/代理失效）时请求可能永挂不返回，
      // 若不设超时会占住 rateLimiter 队头 -> 锁死整条队列；超时 destroy 触发 error -> reject。
      // [警告] 注：Node req.setTimeout 是「socket 空闲超时」(idle timeout)——仅在 socket 无任何
      //    活动时触发；「持续小流量但永不 end」的响应不会被它覆盖（由 rateLimiter 的
      //    任务级超时兜底，见 core/rate-limiter.js）。
      req.setTimeout(requestTimeoutMs(), () => {
        req.destroy(new Error(`VRChat API 下载超时 (${requestTimeoutMs()}ms): ${url}`));
      });

      req.on('error', reject);
      req.end();
    });
  }
}
