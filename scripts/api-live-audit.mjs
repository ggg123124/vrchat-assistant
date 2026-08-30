// 全量 GET 实测：用真实凭据+真实资源 ID 逐个调用域方法，输出状态矩阵
// 用法：VRC_MONITOR_DIR=<仓库路径> COOKIE_FILE=<cookie文件> [VRC_MONITOR_USER_ID=<userId>] node scripts/api-live-audit.mjs
const REPO = process.env.VRC_MONITOR_DIR || new URL('..', import.meta.url).pathname;
const { VrchatApiClient } = await import(REPO + 'core/vrchat-api.js');
const api = new VrchatApiClient('', '');
api.loadCookieFromFile(process.env.COOKIE_FILE || REPO + 'data/auth_cookie.txt');
try { await api.ensureAuth(); } catch (e) { console.log('ensureAuth 失败（继续用现有 cookie）:', String(e.message || e).slice(0, 60)); }

const results = [];
async function probe(name, path, fn) {
  try {
    const r = await fn();
    const status = r.status;
    const body = r.data;
    const info = body === undefined || body === null ? '空'
      : Array.isArray(body) ? `数组[${body.length}]`
      : typeof body === 'object' ? Object.keys(body).slice(0, 4).join(',')
      : String(body).slice(0, 30);
    results.push({ name, status: String(status), info, path });
  } catch (e) {
    results.push({ name, status: 'THROW', info: String(e.message || e).slice(0, 60), path });
  }
  await new Promise(r => setTimeout(r, 350));
}

const me = process.env.VRC_MONITOR_USER_ID || ''; // 必填：自己的 userId
if (!me) { console.error('请设置 VRC_MONITOR_USER_ID=<你的 userId>'); process.exit(2); }

// Phase 1: 无参/自足 GET
await probe('getConfig', '/config', () => api.getConfig());
await probe('getVisits', '/visits', () => api.getVisits());
await probe('verifyAuthToken', '/auth', () => api.verifyAuthToken());
await probe('getFriends(不传=仅在线)', '/auth/user/friends', () => api.getFriends());
await probe('getFavoriteLimits', '/auth/user/favoritelimits', () => api.getFavoriteLimits());
await probe('getNotifications', '/auth/user/notifications', () => api.getNotifications({ n: 10 }));
await probe('getPlayerModerations', '/auth/user/playermoderations', () => api.getPlayerModerations());
await probe('getAvatarModerations', '/auth/user/avatarmoderations', () => api.getAvatarModerations());
await probe('listFavoriteGroups', '/favorite/groups', () => api.listFavoriteGroups({ n: 50 }));
await probe('listFavorites(friend)', '/favorites?type=friend', () => api.listFavorites({ type: 'friend', n: 50 }));
await probe('listFiles', '/files', () => api.listFiles({ n: 20 }));
await probe('listPrints', '/prints/user/{uid}', () => api.listPrints());
await probe('getInviteMessages(message)', '/message/{uid}/message', () => api.getInviteMessages('message', { n: 20 }));
await probe('listCalendarEvents', '/calendar', () => api.listCalendarEvents({ n: 10 }));
await probe('listFeaturedCalendarEvents', '/calendar/featured', () => api.listFeaturedCalendarEvents());
await probe('listFollowedCalendarEvents', '/calendar/following', () => api.listFollowedCalendarEvents());
await probe('getInventory', '/inventory', () => api.getInventory({ n: 20 }));
await probe('getGlobalInventory', '/inventory/global', () => api.getGlobalInventory());
await probe('getInventoryDrops', '/inventory/drops', () => api.getInventoryDrops());
await probe('getGroupRoleTemplates', '/groups/roleTemplates', () => api.getGroupRoleTemplates());
await probe('searchUsers(自己)', '/users?search=', () => api.searchUsers(process.env.VRC_MONITOR_SEARCH_USER || 'vrc', 5));
await probe('searchWorlds', '/worlds?search=', () => api.searchWorlds({ search: 'vrchat', n: 5 }));
await probe('listActiveWorlds', '/worlds/active', () => api.listActiveWorlds({ n: 5 }));
await probe('listRecentWorlds', '/worlds/recent', () => api.listRecentWorlds({ n: 5 }));
await probe('listFavoritedWorlds', '/worlds/favorites', () => api.listFavoritedWorlds({ n: 5 }));
await probe('listFavoritedAvatars', '/avatars/favorites', () => api.listFavoritedAvatars({ n: 5 }));
await probe('listLicensedAvatars', '/avatars/licensed', () => api.listLicensedAvatars({ n: 5 }));
await probe('getAvatarStyles', '/avatarStyles', () => api.getAvatarStyles());

// Phase 2: 真实 ID 参数化 GET
const friends = await api.fetchAllFriends();
const onlineFriend = friends.find(f => f.location && f.location !== 'offline');
const anyFriend = friends[0];
await probe('getUser(自己)', '/users/{id}', () => api.getUser(me));
await probe('getOwnAvatar', '/users/{id}/avatar', () => api.getOwnAvatar(me));
await probe('getUserGroups(自己)', '/users/{id}/groups', () => api.getUserGroups(me));
await probe('getRepresentedGroup(自己)', '/users/{id}/groups/represented', () => api.getRepresentedGroup(me));
await probe('getUserBalance(自己)', '/user/{id}/balance', () => api.getUserBalance(me));
await probe('getUserGroupInstances(自己)', '/users/{id}/instances/groups', () => api.getUserGroupInstances(me, { n: 10 }));
await probe('getMutualFriends(好友)', '/users/{id}/mutuals/friends', () => api.getMutualFriends(anyFriend.id, { n: 10 }));
await probe('getMutualGroups(好友)', '/users/{id}/mutuals/groups', () => api.getMutualGroups(anyFriend.id));
await probe('getFriendStatus(好友)', '/user/{id}/friendStatus', () => api.getFriendStatus(anyFriend.id));
await probe('fetchAllFriends(合并)', '双列表', async () => ({ status: 200, data: (await api.fetchAllFriends()).map(f => f.id) }));

await probe('searchWorlds→world三连', null, async () => {
  const w = await api.searchWorlds({ search: 'Cube MMD Studio', n: 3 });
  const wid = w.data?.[0]?.id;
  if (!wid) return { status: 'SKIP', data: '未找到世界' };
  const r1 = await api.getWorld(wid);
  const r2 = await api.getWorldMetadata(wid);
  const r3 = await api.getWorldPublishStatus(wid).catch(e => ({ status: e.status || 'ERR' }));
  return { status: `getWorld=${r1.status} meta=${r2.status} pub=${r3.status}`, data: wid };
});
await probe('getInstance(好友当前房)', null, async () => {
  const loc = onlineFriend?.location;
  if (!loc) return { status: 'SKIP', data: '在线好友无位置' };
  return api.getInstance(loc);
});
await probe('群组三连(加入的群)', null, async () => {
  const gid = process.env.VRC_MONITOR_GROUP_ID || '';
  if (!gid) return { status: 'SKIP', data: '未设置 VRC_MONITOR_GROUP_ID' };
  const r1 = await api.getGroup(gid);
  const r2 = await api.getUserGroups(me);
  const r3 = await api.getGroupInstances(gid).catch(e => ({ status: e.status || 'ERR' }));
  return { status: `getGroup=${r1.status} userGroups=${r2.status} inst=${r3.status}`, data: r1.data?.name || '' };
});
await probe('getInventoryItem(list→id)', null, async () => {
  const inv = await api.getInventory({ n: 20 });
  const item = ((inv.data || {}).data || []).find(x => x.id)?.id;
  if (!item) return { status: 'SKIP', data: '库存空' };
  return api.getInventoryItem(item);
});
await probe('getFile(list→id)', null, async () => {
  const r = await api.listFiles({ n: 5 });
  const fid = (r.data || [])[0]?.id;
  if (!fid) return { status: 'SKIP', data: '无文件' };
  return api.getFile(fid);
});
await probe('getPrint(list→id)', null, async () => {
  const r = await api.listPrints({ n: 5 });
  const pid = (r.data || [])[0]?.id;
  if (!pid) return { status: 'SKIP', data: '无 print' };
  return api.getPrint(pid);
});
await probe('getAvatar(list→id)', null, async () => {
  const r = await api.searchAvatars({ userId: me, n: 3 });
  const aid = (r.data || [])[0]?.id;
  if (!aid) return { status: 'SKIP', data: '无模型' };
  return api.getAvatar(aid);
});

const ok = results.filter(r => r.status.startsWith('200') || r.status.startsWith('SKIP') || r.status.includes('=200'));
const non200 = results.filter(r => !ok.includes(r));
console.log('===== 结果矩阵 =====');
for (const r of results) console.log(String(r.status).padEnd(16), r.name.padEnd(26), String(r.info).slice(0, 46));
console.log(`\n总 ${results.length} | 通过(200/含200/SKIP): ${ok.length} | 非200: ${non200.length}`);
for (const r of non200) console.log('  非200 →', r.name, '|', r.status, '|', r.info);
process.exit(0);
