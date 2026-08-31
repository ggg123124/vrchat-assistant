import { parseLimit, readJsonBody, sendJson } from '../http.js';

export function registerSearchRoutes(api) {
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/nickname',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const userId = url.searchParams.get('userId') || '';
      sendJson(res, await api.tools.call('get_nicknames', { userId }));
    },
  });

  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/nickname',
    handler: async (req, res) => {
      const body = await readJsonBody(req);
      sendJson(res, await api.tools.call('set_nickname', {
        userId: body.userId,
        nickname: body.nickname,
        displayName: body.displayName,
      }));
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/nicknames-all',
    handler: async (_req, res) => {
      try {
        const r = await api.tools.call('get_nicknames', {});
        sendJson(res, { nicknames: (r && r.nicknames) || [] });
      } catch (e) {
        sendJson(res, { nicknames: [], error: String(e.message || e) });
      }
    },
  });

  // /api/dashboard/search 统一搜索由 index.js 注册（规范化 {results:[{kind,id,name,sub,image}]}）——
  // 此处不再重复注册：registerRoute 对重复路径抛「HTTP 路由冲突」并中断本插件后续注册
}
