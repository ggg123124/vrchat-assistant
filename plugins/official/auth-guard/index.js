/**
 * auth-guard 插件 — 公网访问鉴权与安全防护
 *
 * 功能：
 * 1. 注册全局 http.authenticate 鉴权服务供 http-server 消费；
 * 2. 暴露 auth_get_status / auth_generate_token / auth_verify_token 工具。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 从 HTTP 请求中提取 Token（按 Header -> Query 顺序） */
export function extractTokenFromRequest(req) {
  if (!req) return null;

  // 1. Authorization: Bearer <token>
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
      return parts[1];
    }
  }

  // 2. X-API-Key: <token>
  const apiKey = req.headers?.['x-api-key'] || req.headers?.['X-API-KEY'] || req.headers?.['x-auth-token'];
  if (apiKey && typeof apiKey === 'string') {
    return apiKey.trim();
  }

  // 3. URL Query: ?token=<token> 或 ?api_key=<token> 或 ?key=<token>
  if (req.url && req.url.includes('?')) {
    try {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      const qToken = parsedUrl.searchParams.get('token')
        || parsedUrl.searchParams.get('api_key')
        || parsedUrl.searchParams.get('key')
        || parsedUrl.searchParams.get('auth');
      if (qToken) return qToken.trim();
    } catch {}
  }

  return null;
}

/** 常量时间安全比对（防止时序侧信道反推 Token） */
export function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // 长度不等时做一次确定性同长比对，消除长度不同短路的时间差异
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export default function register(api) {
  function getAuthConfig() {
    if (api.hasService('core.authConfig')) {
      return api.consume('core.authConfig');
    }
    return { token: null, host: '127.0.0.1', port: 8799 };
  }

  // ── 1. 提供全局 http.authenticate 服务 ──
  api.provide('http.authenticate', (req) => {
    // 页面入口豁免：/dashboard 前缀（单文件 HTML + legacy 静态资源 vendor/*，均无敏感数据，
    // 数据全靠前端 JS 调 API 加载）——无 token 也放行让前端显示登录页（LoginView）；
    // API 路径(/api//health/mcp)仍严格鉴权。图片代理豁免：<img> 无法带 Authorization header，只服务白名单公图。
    try {
      const pathname = new URL(req.url || '', 'http://localhost').pathname;
      if (req.method === 'GET' && (pathname === '/dashboard' || pathname.startsWith('/dashboard/'))) {
        return { ok: true, enabled: true };
      }
      if (req.method === 'GET' && pathname === '/api/dashboard/image-proxy') {
        return { ok: true, enabled: true };
      }
    } catch {}

    const config = getAuthConfig();
    const configuredToken = config?.token;
    if (!configuredToken) {
      // 未配置 Token 时放行
      return { ok: true, enabled: false };
    }

    const token = extractTokenFromRequest(req);
    if (!token) {
      return {
        ok: false,
        enabled: true,
        message: '未提供访问令牌（请在 Header 携带 Authorization: Bearer <TOKEN> 或 URL 参数 ?token=<TOKEN>）',
      };
    }

    if (!safeCompare(token, configuredToken)) {
      return {
        ok: false,
        enabled: true,
        message: '访问令牌无效或不匹配',
      };
    }

    return { ok: true, enabled: true };
  });

  // ── 2. 工具：查询当前公网鉴权与安全状态 ──
  api.registerTool({
    name: 'auth_get_status',
    description: '查询当前服务的公网鉴权配置状态、网络监听地址与安全就绪度',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const config = getAuthConfig();
      const configuredToken = config?.token;
      const host = config?.host || '127.0.0.1';
      const port = config?.port || 8799;
      const isPublic = host === '0.0.0.0';

      const maskedToken = configuredToken
        ? configuredToken.slice(0, 4) + '****' + configuredToken.slice(-4)
        : null;

      const recommendations = [];
      if (isPublic && !configuredToken) {
        recommendations.push('🔴 警告：服务监听 0.0.0.0 但未配置 VRC_MONITOR_AUTH_TOKEN，公网存在裸奔风险！');
      } else if (configuredToken) {
        recommendations.push('🟢 安全：已启用 Token 鉴权保护。');
      } else {
        recommendations.push('⚪ 提示：服务当前仅监听 127.0.0.1 本地回环。如需公网访问，请在 .env 配置 VRC_MONITOR_AUTH_TOKEN 与 VRC_MONITOR_HOST=0.0.0.0。');
      }

      return {
        authEnabled: !!configuredToken,
        tokenConfigured: !!configuredToken,
        tokenMasked: maskedToken,
        listenHost: host,
        listenPort: port,
        isPublicHost: isPublic,
        supportedAuthMethods: [
          'Header: Authorization: Bearer <TOKEN>',
          'Header: X-API-Key: <TOKEN>',
          'Query: ?token=<TOKEN>',
        ],
        recommendations,
      };
    },
  });

  // ── 3. 工具：生成高强度随机 Token ──
  api.registerTool({
    name: 'auth_generate_token',
    description: '生成 32 字节高强度密码学随机 Token，并提供 .env 配置模版',
    inputSchema: {
      type: 'object',
      properties: {
        length: {
          type: 'number',
          description: 'Token 字节数（默认 32，生成 64 字符十六进制）',
          default: 32,
        },
      },
    },
    handler: async ({ length = 32 }) => {
      const bytes = Math.max(16, Math.min(128, parseInt(length, 10) || 32));
      const token = randomBytes(bytes).toString('hex');

      return {
        generatedToken: token,
        envConfigSnippet: 'VRC_MONITOR_AUTH_TOKEN=' + token + '\nVRC_MONITOR_HOST=0.0.0.0',
        instructions: '将上述配置写入项目根目录 .env 文件并重启服务即可启用公网鉴权保护。',
      };
    },
  });

  // ── 4. 工具：校验指定 Token ──
  api.registerTool({
    name: 'auth_verify_token',
    description: '校验给定的 Token 是否与当前环境变量配置的 Token 匹配',
    inputSchema: {
      type: 'object',
      properties: {
        token: {
          type: 'string',
          description: '待校验的 Token 字符串',
        },
      },
      required: ['token'],
    },
    handler: async ({ token }) => {
      const config = getAuthConfig();
      const configuredToken = config?.token;
      if (!configuredToken) {
        return {
          valid: false,
          authEnabled: false,
          message: '服务当前未配置 VRC_MONITOR_AUTH_TOKEN，鉴权处于未启用状态',
        };
      }

      const match = safeCompare(String(token || ''), configuredToken);
      return {
        valid: match,
        authEnabled: true,
        message: match ? 'Token 匹配成功' : 'Token 不匹配',
      };
    },
  });

  api.log('auth-guard 插件已加载：提供 http.authenticate 服务与公网安全工具');
}
