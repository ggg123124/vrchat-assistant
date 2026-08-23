export default function register(api) {
  const FAVORITE_TAGS = ['worlds0', 'worlds1', 'worlds2', 'worlds3', 'worlds4'];
  const DEFAULT_TAG = 'worlds0';
  const PAGE = 100;

  // 从 display名精确匹配解析 userId
  async function resolveUserId({ userId, displayName }) {
    if (userId) return { userId, displayName: displayName || null };
    if (!displayName) throw new Error('userId or displayName is required');
    const users = await api.vrchat.fetch(`/users?search=${encodeURIComponent(displayName)}&n=20`);
    const matches = (users || []).filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());
    if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
    if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);
    return { userId: matches[0].id, displayName: matches[0].displayName };
  }

  async function fetchAllFavoriteWorlds() {
    const all = [];
    let offset = 0;
    while (true) {
      const data = await api.vrchat.fetch(`/favorites?type=world&n=${PAGE}&offset=${offset}`);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const f of data) {
        all.push({
          favoriteId: f.favoriteId || '',
          worldId: f.favoriteId || f.worldId || '',
          favoriteGroupName: f.favoriteGroupName || '',
          createdAt: f.createdAt || '',
        });
      }
      offset += PAGE;
      if (data.length < PAGE) break;
      if (offset >= 3000) break;
    }
    return all;
  }

  async function fetchWorldDetails(ids) {
    const map = new Map();
    const missing = [];
    for (const id of ids) {
      try {
        let cached = await api.consume('storage.getWorldName', id);
        if (cached) {
          map.set(id, {
            id,
            name: cached.name || '',
            authorName: cached.author_name || '',
            description: (cached.description || '').slice(0, 500),
            imageUrl: cached.image_url || '',
            favorites: cached.favorites || 0,
            visits: typeof cached.visits === 'number' ? cached.visits : null,
            popularity: typeof cached.popularity === 'number' ? cached.popularity : null,
            capacity: cached.capacity || 0,
            tags: (() => { try { const p = JSON.parse(cached.tags || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } })(),
            cached: true,
          });
        } else {
          missing.push(id);
        }
      } catch { missing.push(id); }
    }

    for (const id of missing) {
      try {
        const w = await api.vrchat.fetch(`/worlds/${encodeURIComponent(id)}`);
        if (w) {
          map.set(id, { ...w, cached: false });
          try {
            await api.consume('storage.upsertWorld', {
              worldId: id,
              name: w.name || '',
              authorId: w.authorId || '',
              authorName: w.authorName || '',
              description: (w.description || '').slice(0, 500),
              imageUrl: w.imageUrl || '',
              releaseStatus: w.releaseStatus || 'public',
              capacity: w.capacity || 0,
              favorites: w.favorites || 0,
              tags: Array.isArray(w.tags) ? w.tags : [],
            });
          } catch { /* 缓存失败不影响 */ }
        }
      } catch { /* 单条失败跳过 */ }
    }
    return map;
  }

  const CATEGORY_RULES = [
    { re: /game|ゲーム|fps|racing|race|puzzle|謎解き|udon|battle|対戦|action|アクション|card|カード|sports|スポーツ|tennis|テニス|golf|ボウリング|bowling|shooting|シューティング|mafia|人狼|quiz|クイズ|escape|脱出|parkour|パルクール|obstacle|アスレチック/i, cat: '🎮 游戏' },
    { re: /horror|怖|ホラー|backroom|creepy|不気味|暗い|廃墟|abandoned|サイコ|psycho|呪い|curse|幽霊|ghost|心霊|怪異/i, cat: '👻 恐怖' },
    { re: /music|音楽|dj|ライブ|concert|dance|舞|song|曲|piano|ピアノ|guitar|ギター|instrument|楽器|beat|ビート|k歌|卡拉ok|カラオケ|club|クラブ|party|パーティー|live|sound|サウンド|visualizer/i, cat: '🎵 音乐体验' },
    { re: /景観|景色|scenic|view|観光|landscape|nature|自然|海|sea|ocean|空|sky|山|mountain|星|star|夜空|night sky|夕日|sunset|sunrise|桜|sakura|雪|snow|湖|lake|森|forest|wood|滝|waterfall|river|川|庭園|garden|park|公園|bridge|橋|街|city|town|urban|夜|night|雪景色|葉|autumn|花|flower|温泉|hot spring|島|island/i, cat: '🌄 风景/观光' },
    { re: /avatar|アバター|model|展示|改模|店|shop|store|衣装|outfit|clothes|fashion|コスプレ|cosplay|mascot|マスコット|photo booth/i, cat: '🧍 Avatar/模型' },
    { re: /social|hangout|集合|club|バー|居酒屋|cafe|カフェ|bar|飲み|drink|ラウンジ|lounge|plaza|広場|meet|交流|集会|nightclub/i, cat: '🍻 社交/聚会' },
    { re: /vrcsleep|睡眠|寝る|sleep|chill|チル|relax|リラックス|heal|癒し|癒|comfy|居心地|cozy|まったり|のんびり|休憩|rest|nap|asmr|安眠|sleeping/i, cat: '😴 休闲/睡觉' },
    { re: /photo|写真|撮影|カメラ|camera|photography|グラビア/i, cat: '📷 拍照' },
  ];

  function classify(world) {
    const name = (world.name || '') + ' ' + (world.description || '').slice(0, 200);
    const tags = Array.isArray(world.tags) ? world.tags.join(' ') : '';
    const haystack = name + ' ' + tags;
    for (const rule of CATEGORY_RULES) {
      if (rule.re.test(haystack)) return rule.cat;
    }
    return '其他';
  }

  async function handleFavoriteWorld({ worldId, tag }) {
    if (!worldId || typeof worldId !== 'string' || !worldId.startsWith('wrld_')) {
      throw new Error('worldId is required and must start with wrld_');
    }
    if (tag == null || tag === '') tag = DEFAULT_TAG;
    if (!FAVORITE_TAGS.includes(tag)) {
      throw new Error(`tag must be one of ${FAVORITE_TAGS.join('/')} (got "${tag}")`);
    }

    try {
      const data = await api.vrchat.fetch('/favorites', {
        method: 'POST',
        body: { type: 'world', favoriteId: worldId, tags: [tag] },
      });
      await api.consume('storage.setWorldFavorited', { worldId, favorited: 1 });
      const result = { worldId, favorited: true, tag };
      const cached = await api.consume('storage.getWorldName', worldId);
      const name = cached?.name || data?.name || data?.displayName;
      if (name) result.displayName = name;
      api.log(`⭐ 云端收藏: ${worldId} → ${tag}`);
      return result;
    } catch (e) {
      if (e.status >= 400) {
        const msg = typeof e.response?.error?.message === 'string'
          ? e.response.error.message
          : (typeof e.response === 'string' && e.response ? e.response : '');
        return {
          worldId,
          favorited: false,
          tag,
          error: { status: e.status, message: msg || `API error ${e.status}` },
        };
      }
      throw e;
    }
  }

  async function handleGetMyFavoriteWorlds({ limit = 500, sortBy = 'favorites' } = {}) {
    try {
      const favs = await fetchAllFavoriteWorlds();
      if (favs.length === 0) {
        return { ok: true, total: 0, categories: [], worlds: [], message: '没有收藏的世界' };
      }
      api.log(`[favorite-worlds] 收藏世界 ${favs.length} 个，开始批量查详情`);

      const ids = favs.map(f => f.worldId).filter(Boolean);
      const detailMap = await fetchWorldDetails(ids);

      let zhMap = new Map();
      try {
        zhMap = await api.consume('storage.getZhTranslations', ids);
      } catch { /* 表不存在则跳过 */ }

      const worlds = favs.map(f => {
        const w = detailMap.get(f.worldId) || {};
        return {
          worldId: f.worldId,
          worldName: w.name || '(未知)',
          authorName: w.authorName || '',
          description: (w.description || '').slice(0, 300),
          zhDescription: zhMap.get(f.worldId) || '',
          imageUrl: w.imageUrl || '',
          favorites: w.favorites || 0,
          visits: typeof w.visits === 'number' ? w.visits : null,
          popularity: typeof w.popularity === 'number' ? w.popularity : null,
          capacity: w.capacity || 0,
          tags: Array.isArray(w.tags) ? w.tags : [],
          category: classify(w),
          favoriteGroup: f.favoriteGroupName || '',
          cached: w.cached === true,
        };
      });

      const sorters = {
        favorites: (a, b) => b.favorites - a.favorites,
        visits: (a, b) => b.visits - a.visits,
        name: (a, b) => a.worldName.localeCompare(b.worldName, 'ja'),
      };
      const sorter = sorters[sortBy] || sorters.favorites;

      const categories = {};
      for (const w of worlds) {
        (categories[w.category] = categories[w.category] || []).push(w);
      }
      const catList = Object.entries(categories)
        .map(([name, list]) => ({ name, count: list.length, worlds: list.sort(sorter).slice(0, limit) }))
        .sort((a, b) => b.count - a.count);

      return {
        ok: true,
        total: worlds.length,
        categories: catList.map(c => ({ name: c.name, count: c.count })),
        worlds: catList.flatMap(c => c.worlds),
        message: `共 ${worlds.length} 个收藏世界，分为 ${catList.length} 类`,
      };
    } catch (e) {
      return { ok: false, message: `拉取收藏失败: ${e.message}` };
    }
  }

  async function handleGetMyFavoriteGroups() {
    try {
      const data = await api.vrchat.fetch('/favorite/groups');
      const groups = Array.isArray(data) ? data : [];
      const worldGroups = groups.filter(g => g.type === 'world').map(g => ({
        name: g.displayName || g.name || '',
        capacity: g.visibility === 'private' ? null : (g?.capacity || 0),
      }));
      return { ok: true, groups: worldGroups };
    } catch (e) {
      return { ok: false, message: `拉取收藏分组失败: ${e.message}` };
    }
  }

  async function fetchFriendGroups() {
    const groupsR = await api.vrchat.fetch('/favorite/groups?type=friend&n=100');
    const groups = (Array.isArray(groupsR) ? groupsR : []);
    const favs = [];
    let offset = 0;
    while (true) {
      const data = await api.vrchat.fetch(`/favorites?type=friend&n=100&offset=${offset}`);
      const batch = (Array.isArray(data) ? data : []);
      if (batch.length === 0) break;
      favs.push(...batch);
      if (batch.length < 100) break;
      offset += batch.length;
    }
    return { groups, favs };
  }

  function findGroup(groups, groupName) {
    if (!groupName) return null;
    const q = String(groupName).toLowerCase();
    return groups.find(g => (g.displayName || '').toLowerCase() === q)
        || groups.find(g => (g.name || '').toLowerCase() === q)
        || null;
  }

  async function handleGetFriendFavoriteGroups() {
    const { groups, favs } = await fetchFriendGroups();
    const byGroupTag = new Map();
    for (const f of favs) {
      const tag = (f.tags || [])[0] || '';
      byGroupTag.set(tag, (byGroupTag.get(tag) || 0) + 1);
    }
    return {
      totalGroups: groups.length,
      groups: groups.map(g => ({
        groupId: g.id,
        name: g.name,
        displayName: g.displayName || g.name,
        memberCount: byGroupTag.get(g.name) || 0,
      })),
    };
  }

  async function handleFavoriteFriend({ userId, displayName, groupName, confirm }) {
    if (!groupName) throw new Error('groupName is required');
    const { userId: targetId, displayName: targetName } = await resolveUserId({ userId, displayName });
    const { groups } = await fetchFriendGroups();
    const group = findGroup(groups, groupName);
    if (!group) throw new Error(`收藏分组未找到：${groupName}（可用 get_friend_favorite_groups 查看现有分组）`);
    if (!confirm) {
      return { userId: targetId, displayName: targetName, groupName: group.displayName || group.name, confirmRequired: true, message: `将把 ${targetName || targetId} 加入收藏分组「${group.displayName || group.name}」，请传 confirm: true 确认执行` };
    }
    try {
      await api.vrchat.fetch('/favorites', {
        method: 'POST',
        body: { favoriteId: targetId, tags: [group.name], type: 'friend' },
      });
      api.log(`✅ favorite_friend: ${targetName || targetId} → ${group.displayName || group.name}`);
      return { ok: true, userId: targetId, displayName: targetName, groupName: group.displayName || group.name, favorited: true };
    } catch (e) {
      if (e.status === 400) {
        return { ok: false, userId: targetId, displayName: targetName, groupName: group.displayName || group.name, favorited: false, error: 'already favorited（该好友已在此分组）' };
      }
      if (e.status === 403) {
        return { ok: false, userId: targetId, displayName: targetName, groupName: group.displayName || group.name, favorited: false, error: 'not friends（对方还不是你的好友，无法收藏）' };
      }
      throw e;
    }
  }

  async function handleUnfavoriteFriend({ userId, displayName, groupName, confirm }) {
    const { userId: targetId, displayName: targetName } = await resolveUserId({ userId, displayName });
    const { groups, favs } = await fetchFriendGroups();
    let targetTag = null;
    if (groupName) {
      const group = findGroup(groups, groupName);
      if (!group) throw new Error(`收藏分组未找到：${groupName}（可用 get_friend_favorite_groups 查看现有分组）`);
      targetTag = group.name;
    }
    const records = favs.filter(f => f.favoriteId === targetId && (!targetTag || (f.tags || [])[0] === targetTag));
    if (records.length === 0) {
      return { ok: false, userId: targetId, displayName: targetName, removed: false, error: groupName ? `该好友不在分组「${groupName}」中` : '该好友不在任何收藏分组中' };
    }
    if (!confirm) {
      const groupNames = records.map(r => (r.tags || [])[0]).join(', ');
      return { userId: targetId, displayName: targetName, groupName: groupNames, confirmRequired: true, message: `将从收藏分组「${groupNames}」移除 ${targetName || targetId}，请传 confirm: true 确认执行` };
    }
    for (const rec of records) {
      try {
        await api.vrchat.fetch(`/favorites/${rec.id}`, { method: 'DELETE' });
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    api.log(`✅ unfavorite_friend: ${targetName || targetId} (${records.length} 条记录)`);
    return { ok: true, userId: targetId, displayName: targetName, removed: true, removedGroups: records.map(r => (r.tags || [])[0]) };
  }

  async function handleMoveFriendGroup({ userId, displayName, toGroup, confirm }) {
    if (!toGroup) throw new Error('toGroup is required');
    const { userId: targetId, displayName: targetName } = await resolveUserId({ userId, displayName });
    const { groups, favs } = await fetchFriendGroups();
    const targetGroup = findGroup(groups, toGroup);
    if (!targetGroup) throw new Error(`目标分组未找到：${toGroup}（可用 get_friend_favorite_groups 查看现有分组）`);
    const existing = favs.find(f => f.favoriteId === targetId && (f.tags || [])[0] === targetGroup.name);
    if (existing) {
      return { ok: false, userId: targetId, displayName: targetName, moved: false, error: `该好友已在目标分组「${targetGroup.displayName || targetGroup.name}」中` };
    }
    const oldRecords = favs.filter(f => f.favoriteId === targetId);
    if (!confirm) {
      return { userId: targetId, displayName: targetName, toGroup: targetGroup.displayName || targetGroup.name, confirmRequired: true, message: `将把 ${targetName || targetId} 从 ${oldRecords.length > 0 ? oldRecords.map(r => (r.tags || [])[0]).join(', ') || '无分组' : '无分组'} 移动到「${targetGroup.displayName || targetGroup.name}」（删旧建新），请传 confirm: true 确认执行` };
    }
    for (const rec of oldRecords) {
      try {
        await api.vrchat.fetch(`/favorites/${rec.id}`, { method: 'DELETE' });
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    await api.vrchat.fetch('/favorites', {
      method: 'POST',
      body: { favoriteId: targetId, tags: [targetGroup.name], type: 'friend' },
    });
    api.log(`✅ move_friend_group: ${targetName || targetId} → ${targetGroup.displayName || targetGroup.name}`);
    return { ok: true, userId: targetId, displayName: targetName, moved: true, fromGroups: oldRecords.map(r => (r.tags || [])[0]), toGroup: targetGroup.displayName || targetGroup.name };
  }

  api.registerTool({
    name: 'favorite_world',
    description: '[action·写操作] 把世界加入你的 VRChat 云端收藏夹（POST /favorites，云端写入，调用前请与用户确认）。tag 为收藏分组（worlds0/worlds1/worlds2/worlds3/worlds4，默认 worlds0）。成功后本地 world_cache 标记 favorited=1（供推荐加权）。API 拒绝（如重复收藏）时返回 favorited:false + error，不抛错。',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'VRChat world id (wrld_...)' },
        tag: { type: 'string', description: '收藏夹分组 tag（worlds0/worlds1/worlds2/worlds3/worlds4，默认 worlds0）' },
      },
      required: ['worldId'],
    },
    handler: async (args) => handleFavoriteWorld(args),
  });

  api.registerTool({
    name: 'get_my_favorite_worlds',
    description: '[查询·收藏] 拉取当前账号收藏的全部世界，按标签分类（🎮游戏/👻恐怖/🎵音乐体验/🌄风景观光/🧍Avatar模型/🍻社交聚会/😴休闲睡觉/📷拍照/其他），返回世界名/作者/收藏/浏览/简介/分类。注意：首次调用（无缓存预热）需逐个查询详情，400 收藏约 15-20 分钟；缓存命中后秒回（cached 字段区分）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '每类返回条数上限，默认 500' },
        sortBy: { type: 'string', enum: ['favorites', 'visits', 'name'], description: '排序方式，默认 favorites' },
      },
    },
    handler: async (args) => handleGetMyFavoriteWorlds(args),
  });

  api.registerTool({
    name: 'get_my_favorite_groups',
    description: '[查询·收藏] 列出当前账号的世界收藏分组（收藏夹名，含容量上限 capacity）。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args) => handleGetMyFavoriteGroups(args),
  });

  api.registerTool({
    name: 'get_friend_favorite_groups',
    description: '[query·收藏] 列出好友收藏分组（分组名 + 显示名 + 成员数）。数据来自 GET /favorite/groups?type=friend + GET /favorites?type=friend。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args) => handleGetFriendFavoriteGroups(args),
  });

  api.registerTool({
    name: 'favorite_friend',
    description: '[write·收藏] 把好友加入收藏分组（POST /favorites type=friend）。groupId/displayName 二选一；groupName 必填（显示名或分组名，可用 get_friend_favorite_groups 查看）。须已是好友（403 返回 not friends）；重复收藏返回 already favorited（不抛错）。写操作，confirm: true 才执行。',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Friend user id (usr_...) — mutually exclusive with displayName' },
        displayName: { type: 'string', description: 'Exact display name to search and favorite — mutually exclusive with userId' },
        groupName: { type: 'string', description: 'Target favorite group name or displayName (required)' },
        confirm: { type: 'boolean', description: 'Must be true to actually favorite. Default false returns preview only.' },
      },
      required: ['groupName'],
    },
    handler: async (args) => handleFavoriteFriend(args),
  });

  api.registerTool({
    name: 'unfavorite_friend',
    description: '[write·收藏] 从收藏分组移除好友（DELETE /favorites/{记录id}，可逆）。groupId/displayName 二选一；groupName 可选（省略 = 从全部分组移除）。写操作，confirm: true 才执行。',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Friend user id (usr_...) — mutually exclusive with displayName' },
        displayName: { type: 'string', description: 'Exact display name to search and unfavorite — mutually exclusive with userId' },
        groupName: { type: 'string', description: 'Favorite group to remove from (optional; omit = remove from all groups)' },
        confirm: { type: 'boolean', description: 'Must be true to actually unfavorite. Default false returns preview only.' },
      },
    },
    destructive: true,
    handler: async (args) => handleUnfavoriteFriend(args),
  });

  api.registerTool({
    name: 'move_friend_group',
    description: '[write·收藏] 移动好友到另一收藏分组（删旧建新，与 VRCX 行为一致；API 无原地更新 tags 端点）。groupId/displayName 二选一；toGroup 必填。写操作，confirm: true 才执行。',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Friend user id (usr_...) — mutually exclusive with displayName' },
        displayName: { type: 'string', description: 'Exact display name to search and move — mutually exclusive with userId' },
        toGroup: { type: 'string', description: 'Target favorite group name or displayName (required)' },
        confirm: { type: 'boolean', description: 'Must be true to actually move. Default false returns preview only.' },
      },
      required: ['toGroup'],
    },
    destructive: true,
    handler: async (args) => handleMoveFriendGroup(args),
  });
}
