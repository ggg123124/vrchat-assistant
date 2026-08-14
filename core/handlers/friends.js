/**
 * 好友查询 handler — 在线好友 / 详情 / 搜索 / 共同好友 / 加好友 / 删好友
 */

import { ctx, log, parseLocation } from '../server-context.js';

export async function handleGetOnlineFriends() {
  const { storage, api } = ctx;
  const r = await api._request('GET', '/auth/user/friends?offline=false');
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const friends = Array.isArray(r.data) ? r.data : [];
  const online = friends.filter(f => f.location && f.location !== 'offline');

  const nicknames = storage.getNicknames({});
  const nicknameMap = new Map();
  for (const item of nicknames) {
    if (item.userId) nicknameMap.set(item.userId, item.nickname);
  }

  return {
    online: online.length,
    total: friends.length,
    friends: online.map(f => ({
      userId: f.id,
      displayName: f.displayName,
      location: f.location || 'private',
      status: f.status,
      statusDescription: f.statusDescription,
      platform: f.platform,
      avatarImageUrl: f.currentAvatarThumbnailImageUrl,
      nickname: nicknameMap.get(f.id) || null,
      locationParsed: parseLocation(f.location || 'private'),
    })),
  };
}

export async function handleGetFriendInfo({ userId, displayName }) {
  const { api } = ctx;
  let targetId = userId;
  if (!targetId && displayName) {
    // 搜索用户
    const r = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=5`);
    if (r.status !== 200) throw new Error(`API error: ${r.status}`);
    const users = Array.isArray(r.data) ? r.data : [];
    if (users.length === 0) return { error: 'User not found' };
    targetId = users[0].id;
  }
  if (!targetId) throw new Error('Provide userId or displayName');

  const r = await api._request('GET', `/users/${targetId}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const u = r.data;
  return {
    userId: u.id,
    displayName: u.displayName,
    bio: u.bio,
    status: u.status,
    statusDescription: u.statusDescription,
    state: u.state,
    location: u.location,
    worldId: u.worldId,
    platform: u.platform,
    avatarImageUrl: u.currentAvatarImageUrl,
    avatarThumbnail: u.currentAvatarThumbnailImageUrl,
    tags: u.tags,
    developerType: u.developerType,
    isFriend: u.isFriend,
    lastLogin: u.last_login,
    pastDisplayNames: u.pastDisplayNames,
    dateJoined: u.date_joined,
    ageVerification: u.ageVerificationStatus,
  };
}

export async function handleSearchUsers({ query, limit = 10 }) {
  const { api, storage } = ctx;
  const n = Math.max(1, Math.min(50, Number(limit) || 10));
  const r = await api._request('GET', `/users?search=${encodeURIComponent(query)}&n=${n}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  // VRChat API 的 /users?search= 是子串模糊匹配：当查询含 API 无法精确命中的部分
  // （如中文/特殊字符）时，会退化匹配查询中的 ASCII 尾巴，返回完全不相关的用户
  // （实测 query="不存在的名字xyz" 返回一堆名字含 "xyz" 的无关用户）。
  // 这里做客户端二次过滤：displayName 必须包含完整查询串（不区分大小写）才算命中，
  // 剔除 API 的退化匹配结果。正常模糊搜索语义不受影响（"abc" 仍命中 "Abc~" 等）。
  const q = query.toLowerCase();
  const apiResults = (Array.isArray(r.data) ? r.data : [])
    .filter(u => u.displayName && u.displayName.toLowerCase().includes(q))
    .map(u => ({
      userId: u.id,
      displayName: u.displayName,
      bio: (u.bio || '').slice(0, 100),
      status: u.status,
      isFriend: u.isFriend,
    }));

  // API 无匹配时回退：优先在本地好友库模糊搜索（display_name / memo 含查询字眼）。
  // 覆盖 API 中文搜索差 / 昵称备注场景——好友可能只有中文备注名或 API 搜不到。
  // 仅返回本地好友，不额外调用 API，命中后标记 source 便于区分。
  if (apiResults.length === 0) {
    const localHits = storage.searchFriends(query)
      .filter(f => f.display_name || f.memo)
      .slice(0, n)
      .map(f => ({
        userId: f.user_id,
        displayName: f.display_name || f.memo,
        bio: f.memo || '',
        status: f.status || '',
        isFriend: true,
        source: 'local_friends',
        trustLevel: f.trust_level || null,
        online: !!f.is_online,
      }));
    return { query, results: localHits, fallback: 'local_friends' };
  }

  return { query, results: apiResults };
}

export async function handleGetMutualFriends({ userId, displayName, limit = 100 }) {
  const { api, storage } = ctx;
  if (!userId && !displayName) throw new Error('userId or displayName is required');

  let targetId = userId;
  let targetDisplayName = null;

  if (!targetId) {
    const search = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
    if (search.status !== 200) throw new Error(`API error: ${search.status}`);
    const users = Array.isArray(search.data) ? search.data : [];
    const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());

    if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
    if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);

    targetId = matches[0].id;
    targetDisplayName = matches[0].displayName;
  }

  const n = Math.max(1, Math.min(100, Number(limit) || 100));
  const r = await api._request('GET', `/users/${targetId}/mutuals/friends?n=${n}&offset=0`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const nicknames = storage.getNicknames({});
  const nicknameMap = new Map();
  for (const item of nicknames) {
    if (item.userId) nicknameMap.set(item.userId, item.nickname);
  }

  const mutuals = Array.isArray(r.data) ? r.data : [];
  const mutualFriends = mutuals.map(u => ({
    userId: u.id,
    displayName: u.displayName,
    nickname: nicknameMap.get(u.id) || null,
    isFriend: u.isFriend !== undefined ? u.isFriend : true,
  }));

  return {
    userId: targetId,
    displayName: targetDisplayName,
    total: mutualFriends.length,
    mutualFriends,
  };
}

export async function handleSendFriendRequest({ userId, displayName }) {
  const { api } = ctx;
  if (!userId && !displayName) throw new Error('userId or displayName is required');

  if (userId) {
    const r = await api.sendFriendRequest(userId);
    if (r.status >= 400) throw new Error(`API error ${r.status}`);
    return { userId, displayName: null, method: 'userId', ok: true };
  }

  const search = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
  if (search.status !== 200) throw new Error(`API error: ${search.status}`);
  const users = Array.isArray(search.data) ? search.data : [];
  const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());

  if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
  if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);

  const target = matches[0];
  if (target.isFriend) throw new Error(`"${displayName}" 已经是你的好友，无需重复添加`);
  const r = await api.sendFriendRequest(target.id);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { userId: target.id, displayName, method: 'displayName', ok: true };
}

export async function handleRemoveFriend({ userId, displayName, confirm }) {
  const { api } = ctx;
  if (!userId && !displayName) throw new Error('userId or displayName is required');

  let target = { userId, displayName };
  if (!userId) {
    const search = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
    if (search.status !== 200) throw new Error(`API error: ${search.status}`);
    const users = Array.isArray(search.data) ? search.data : [];
    const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());

    if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
    if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);

    const found = matches[0];
    if (found.isFriend === false) throw new Error(`"${displayName}" 不是你的好友，无需删除`);
    target = { userId: found.id, displayName };
  }

  if (!confirm) {
    return { userId: target.userId, displayName: target.displayName, confirmRequired: true, message: '删除好友不可逆，请传 confirm: true 确认执行' };
  }

  const r = await api.removeFriend(target.userId);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { userId: target.userId, displayName: target.displayName, ok: true };
}
