// index.js — friend-removals 官方插件：查询「被解除好友」记录（friend-delete 事件）
//
// 背景：VRChat WS 会推送 friend-delete（对方解除与我的好友关系），核心事件流已实时
// 落库 events 表（type='friend-delete'）并自动把该好友从 friends 表移除。但删除事件
// 本身不带对方显示名，且此前 get_recent_events(typeFilter=...) 是「先取最近窗口再内存
// 过滤」，低频类型查不到历史（2026-09-06 修复为 SQL 层类型过滤后可全史检索）。
//
// 本插件为纯 api 实现（契约 v1.2）：不 import 核心、不触碰 ctx、无自有表、无持久化——
//   - 经 api.tools.call('get_recent_events', { typeFilter:'friend-delete', ... }) 拉事件
//   - 经 api.tools.call('get_friend_events', { userId }) 回填对方最后使用的显示名
//   - 经 api.tools.call('get_nicknames', {}) 拼本地昵称
export default function register(api) {
  const PAGE = 100; // 单次拉取步长（friend-delete 极稀疏，循环兜底深分页）

  api.registerTool({
    name: 'get_friend_removals',
    description:
      "[query] 查询「被解除好友」记录（friend-delete 事件——历史上谁把我从好友列表删了）。userId 可选（省略=全部好友）；days=N 只看最近 N 天（默认 0=全部历史）；limit(1-200)/offset 分页。每条返回 { userId, displayName（尽力回填其最后使用的显示名，查无则空串）, nickname（本地昵称，未设则 null）, createdAt（解除时间 ISO UTC）, source }。数据来自核心事件流本地库（对方删除我时 VRChat WS 推送，非主动删除）。",
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '限定某个 userId 的解除记录（默认全部）' },
        days: { type: 'number', description: '只看最近 N 天（默认 0 = 全部历史）' },
        limit: { type: 'number', description: '返回条数上限（默认 20，最大 200）' },
        offset: { type: 'number', description: '分页偏移（默认 0）' },
      },
    },
    handler: async (args) => {
      const cap = Math.min(Math.max(parseInt(args?.limit, 10) || 20, 1), 200);
      const off = Math.max(parseInt(args?.offset, 10) || 0, 0);
      const days = Math.max(parseInt(args?.days, 10) || 0, 0);
      const since = days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : '';

      // 1) 拉 friend-delete 事件（核心按类型 SQL 检索、时间倒序；循环分页直到覆盖所需）
      const raw = [];
      for (let page = 0; page < 50; page++) {
        let r;
        try {
          r = await api.tools.call('get_recent_events', {
            typeFilter: 'friend-delete',
            userIdFilter: args?.userId || undefined,
            limit: PAGE,
            offset: page * PAGE,
          });
        } catch (e) {
          api.log(`get_recent_events 拉取失败：${e.message}`);
          break;
        }
        const evs = Array.isArray(r?.events) ? r.events : [];
        raw.push(...evs);
        if (evs.length < PAGE) break; // 无更多
      }
      // days 窗口过滤（仅当给出 days）
      const inWindow = since ? raw.filter((e) => (e.created_at || '') >= since) : raw;
      const pageItems = inWindow.slice(off, off + cap);

      // 2) 昵称表一次拿全
      let nickMap = new Map();
      try {
        const nr = await api.tools.call('get_nicknames', {});
        const list = Array.isArray(nr?.nicknames) ? nr.nicknames : [];
        nickMap = new Map(list.map((n) => [n.userId, n.nickname || null]));
      } catch (e) {
        api.log(`get_nicknames 读取失败（昵称留空）：${e.message}`);
      }

      // 3) 显示名回填：friend-delete 事件本身不带对方名字（解除后 VRChat 不再回填），
      //    查该 userId 历史最近一条带非空 display_name 的事件（如删除前的 friend-location）
      const ids = [...new Set(pageItems.map((e) => e.user_id || e.userId).filter(Boolean))];
      const nameByUser = new Map();
      await Promise.all(
        ids.map(async (uid) => {
          try {
            const r = await api.tools.call('get_friend_events', { userId: uid, limit: 20 });
            const evs = Array.isArray(r?.events) ? r.events : [];
            const named = evs.find((e) => e.display_name || e.displayName);
            if (named) nameByUser.set(uid, named.display_name || named.displayName || '');
          } catch (e) {
            api.log(`get_friend_events(${uid}) 回填名字失败：${e.message}`);
          }
        })
      );

      const items = pageItems.map((e) => {
        const uid = e.user_id || e.userId;
        return {
          userId: uid,
          displayName: nameByUser.get(uid) || e.display_name || e.displayName || '',
          nickname: nickMap.get(uid) ?? null,
          createdAt: e.created_at || e.createdAt || '',
          source: e.source || '',
        };
      });
      return { total: inWindow.length, items };
    },
  });

  api.log('friend-removals 已加载：get_friend_removals（谁把我删了）');
  return () => {};
}
