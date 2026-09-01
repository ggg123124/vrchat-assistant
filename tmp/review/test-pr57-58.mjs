// PR#57 (notifications) + PR#58 (friend-favorites) handler 逻辑实测（mock api._request，不触碰真实账号）
import { copyFileSync } from 'node:fs';
copyFileSync('core/server-context.js', 'tmp/review/server-context.js');
const { ctx } = await import('file:///D:/workspace/vrcx-mcp-actions/tmp/review/server-context.js');
const notif = await import('file:///D:/workspace/vrcx-mcp-actions/tmp/review/head/notifications.js');
const fav = await import('file:///D:/workspace/vrcx-mcp-actions/tmp/review/head/friend-favorites.js');

let failed = 0;
const T = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? '  [' + extra + ']' : '')); if (!cond) failed++; };

// ── 通用 mock ──
const calls = [];
const mockApi = (responder) => ({
  async _request(method, path, body = null) {
    calls.push({ method, path, body });
    return responder(method, path, body);
  },
});
ctx.rateLimiter = { execute: async (fn) => fn() };

// ══════════════ PR#57 通知收件箱 ══════════════
let seq = 0;
const mkNotif = (over = {}) => ({ id: 'not_' + (++seq), type: 'friendRequest', message: 'hi', senderUserId: 'usr_x', senderUsername: 'X', details: '{"foo":1}', created_at: '2026-08-19T00:00:00Z', hidden: false, ...over });

{
  // 1) get_notifications 默认（未读、全类型）
  calls.length = 0;
  const notifs = [mkNotif(), mkNotif({ type: 'invite', hidden: true }), mkNotif({ type: 'message', hidden: true }), mkNotif({ type: 'votetokick' })];
  ctx.api = mockApi(() => ({ status: 200, data: notifs }));
  const r = await notif.handleGetNotifications({});
  T('57-1 默认仅未读且过滤 hidden', r.notifications.length === 2 && r.shown === 2 && r.notifications.every(n => !n.hidden));
  T('57-1 URL 含 n/offset', calls[0].path === '/auth/user/notifications?n=30&offset=0');
  T('57-1 details JSON 解码', r.notifications[0].details && r.notifications[0].details.foo === 1);

  // 2) types 过滤
  ctx.api = mockApi(() => ({ status: 200, data: notifs }));
  const r2 = await notif.handleGetNotifications({ types: 'friendRequest,invite' });
  T('57-2 types 过滤', r2.notifications.length === 1 && r2.notifications[0].type === 'friendRequest' && r2.filteredByTypes.length === 2);

  // 3) hidden=true 只返回隐藏
  ctx.api = mockApi(() => ({ status: 200, data: notifs }));
  const r3 = await notif.handleGetNotifications({ hidden: true });
  T('57-3 hidden=true', r3.notifications.length === 2 && r3.notifications.every(n => n.hidden));

  // 4) see_notification
  calls.length = 0;
  ctx.api = mockApi(() => ({ status: 200, data: {} }));
  const r4 = await notif.handleSeeNotification({ notificationId: 'not_1' });
  T('57-4 see PUT 端点', calls[0].method === 'PUT' && calls[0].path === '/auth/user/notifications/not_1/see' && r4.ok);
  try { await notif.handleSeeNotification({}); T('57-4 缺 id 抛错', false); } catch (e) { T('57-4 缺 id 抛错', true); }

  // 5) hide_notification
  calls.length = 0;
  ctx.api = mockApi(() => ({ status: 200, data: {} }));
  const r5 = await notif.handleHideNotification({ notificationId: 'not_2' });
  T('57-5 hide PUT 端点', calls[0].method === 'PUT' && calls[0].path === '/auth/user/notifications/not_2/hide' && r5.hidden);

  // 6) accept_friend_request：confirm 护栏
  calls.length = 0;
  ctx.api = mockApi(() => ({ status: 200, data: {} }));
  const r6a = await notif.handleAcceptFriendRequest({ notificationId: 'frq_1' });
  T('57-6 无 confirm 只预览不请求', r6a.confirmRequired === true && calls.length === 0);
  const r6b = await notif.handleAcceptFriendRequest({ notificationId: 'frq_1', confirm: true });
  T('57-6 confirm 后 PUT accept', calls[0].method === 'PUT' && calls[0].path === '/auth/user/notifications/frq_1/accept' && r6b.accepted);
  ctx.api = mockApi(() => ({ status: 404, data: {} }));
  try { await notif.handleAcceptFriendRequest({ notificationId: 'frq_1', confirm: true }); T('57-6 404 抛错', false); } catch (e) { T('57-6 404 抛错', /不存在/.test(e.message)); }

  // 7) decline_friend_request：hide 即清除
  calls.length = 0;
  ctx.api = mockApi(() => ({ status: 200, data: {} }));
  const r7 = await notif.handleDeclineFriendRequest({ notificationId: 'frq_2', confirm: true });
  T('57-7 decline = PUT hide', calls[0].method === 'PUT' && calls[0].path === '/auth/user/notifications/frq_2/hide' && r7.declined);
}

// ══════════════ PR#58 好友收藏分组 ══════════════
{
  const groups = [
    { id: 'fvgrp_1', name: 'group_0', displayName: '亲友团' },
    { id: 'fvgrp_2', name: 'group_1', displayName: '游戏搭子' },
  ];
  const favs = [
    { id: 'fvrt_1', favoriteId: 'usr_a', tags: ['group_0'], type: 'friend' },
    { id: 'fvrt_2', favoriteId: 'usr_b', tags: ['group_0'], type: 'friend' },
    { id: 'fvrt_3', favoriteId: 'usr_b', tags: ['group_1'], type: 'friend' },
    { id: 'fvrt_4', favoriteId: 'usr_c', tags: ['group_1'], type: 'friend' },
    { id: 'fvrt_5', favoriteId: 'usr_z', tags: ['group_0'], type: 'friend' },
  ];
  const users = [
    { id: 'usr_d', displayName: 'Dora' },
    { id: 'usr_e', displayName: 'dora' }, // 同名不同大小写
    { id: 'usr_z', displayName: 'Zoe' },
  ];
  const responder = (method, path) => {
    if (path.startsWith('/favorite/groups')) return { status: 200, data: groups };
    if (path.startsWith('/favorites') && method === 'GET') return { status: 200, data: favs };
    if (path.startsWith('/users?')) {
      const q = decodeURIComponent(path.split('search=')[1].split('&')[0]).toLowerCase();
      return { status: 200, data: users.filter(u => u.displayName.toLowerCase() === q) };
    }
    return { status: 200, data: {} };
  };

  // 1) get_friend_favorite_groups：成员数按 tags[0]
  ctx.api = mockApi(responder);
  const r1 = await fav.handleGetFriendFavoriteGroups();
  const g0 = r1.groups.find(g => g.name === 'group_0');
  T('58-1 分组列表+成员数', r1.totalGroups === 2 && g0.memberCount === 3 && r1.groups[0].displayName === '亲友团');

  // 2) favorite_friend：confirm 护栏 + POST body
  calls.length = 0;
  ctx.api = mockApi(responder);
  const r2a = await fav.handleFavoriteFriend({ displayName: 'Zoe', groupName: '亲友团' });
  T('58-2 无 confirm 只预览（无写请求）', r2a.confirmRequired === true && !calls.some(c => c.method === 'POST' || c.method === 'DELETE'));
  calls.length = 0;
  const r2b = await fav.handleFavoriteFriend({ displayName: 'Zoe', groupName: '亲友团', confirm: true });
  T('58-2 confirm 后 POST /favorites', calls.some(c => c.method === 'POST' && c.path === '/favorites' && c.body.favoriteId === 'usr_z' && JSON.stringify(c.body.tags) === '["group_0"]') && r2b.favorited);

  // 2b) 大小写歧义：Dora + dora 同时存在 → 明确报错
  try { await fav.handleFavoriteFriend({ displayName: 'Dora', groupName: '亲友团', confirm: true }); T('58-2b 歧义报错', false); }
  catch (e) { T('58-2b 歧义报错', /多个用户/.test(e.message)); }

  // 3) favorite_friend：分组不存在 → 报错
  try { await fav.handleFavoriteFriend({ displayName: 'Zoe', groupName: '不存在的组', confirm: true }); T('58-3 分组不存在报错', false); } catch (e) { T('58-3 分组不存在报错', /未找到/.test(e.message)); }

  // 4) favorite_friend：400 重复 / 403 非好友
  ctx.api = mockApi((m, p) => p.startsWith('/favorites') && m === 'POST' ? { status: 400, data: {} } : responder(m, p));
  const r4 = await fav.handleFavoriteFriend({ displayName: 'Zoe', groupName: '亲友团', confirm: true });
  T('58-4 400 → already favorited 不抛错', r4.ok === false && /already/.test(r4.error));
  ctx.api = mockApi((m, p) => p.startsWith('/favorites') && m === 'POST' ? { status: 403, data: {} } : responder(m, p));
  const r4b = await fav.handleFavoriteFriend({ displayName: 'Zoe', groupName: '亲友团', confirm: true });
  T('58-4 403 → not friends', r4b.ok === false && /not friends/.test(r4b.error));

  // 5) ★unfavorite_friend：groupName 拼错 → 是否静默全删？★
  calls.length = 0;
  ctx.api = mockApi(responder);
  const r5 = await fav.handleUnfavoriteFriend({ displayName: 'Zoe', groupName: '亲友团拼错', confirm: true });
  const deleted = calls.filter(c => c.method === 'DELETE');
  console.log('  [58-5] 拼错分组名: removed=', r5.removed, 'deleted records=', JSON.stringify(deleted.map(c => c.path)));
  T('58-5 拼错分组名不应静默全删', r5.removed !== true && deleted.length === 0);

  // 6) unfavorite_friend：正常单组移除
  calls.length = 0;
  ctx.api = mockApi(responder);
  const r6 = await fav.handleUnfavoriteFriend({ displayName: 'Zoe', groupName: '亲友团', confirm: true });
  T('58-6 正常移除 DELETE 记录 id', r6.removed && calls.some(c => c.method === 'DELETE' && c.path === '/favorites/fvrt_5') && r6.removedGroups[0] === 'group_0');

  // 7) move_friend_group：删旧建新
  calls.length = 0;
  ctx.api = mockApi(responder);
  const r7 = await fav.handleMoveFriendGroup({ displayName: 'Zoe', toGroup: '游戏搭子' });
  T('58-7 无 confirm 只预览（无写请求）', r7.confirmRequired === true && !calls.some(c => c.method === 'POST' || c.method === 'DELETE'));
  calls.length = 0;
  const r7b = await fav.handleMoveFriendGroup({ displayName: 'Zoe', toGroup: '游戏搭子', confirm: true });
  const dels = calls.filter(c => c.method === 'DELETE');
  const posts = calls.filter(c => c.method === 'POST');
  T('58-7 confirm 后删旧建新', dels.length === 1 && dels[0].path === '/favorites/fvrt_5' && posts.length === 1 && posts[0].body.tags[0] === 'group_1' && r7b.moved);
}

console.log('\n===== 结果: ' + (failed === 0 ? '全部 PASS' : failed + ' 项 FAIL') + ' =====');
process.exit(failed === 0 ? 0 : 1);
