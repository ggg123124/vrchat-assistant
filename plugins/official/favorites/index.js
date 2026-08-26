export default function register(api) {
  const PAGE = 100;
  const WORLD_TYPES = ['world', 'vrcPlusWorld'];

  // 世界收藏类型推断：vrcPlusWorlds* → vrcPlusWorld，worlds* → world
  function worldTypeByTag(tag) {
    return (typeof tag === 'string' && tag.startsWith('vrcPlusWorld')) ? 'vrcPlusWorld' : 'world';
  }

  // 动态发现世界收藏分组（world + vrcPlusWorld）。withLimits=true 时合并 /auth/user/favoritelimits 的每分组容量。
  async function discoverWorldGroups(withLimits = false) {
    const groupsRaw = await api.vrchat.fetch('/favorite/groups?n=100');
    const groups = Array.isArray(groupsRaw) ? groupsRaw : [];
    let maxPerGroup = null;
    if (withLimits) {
      const limits = await api.vrchat.fetch('/auth/user/favoritelimits');
      maxPerGroup = (limits && limits.maxFavoritesPerGroup && typeof limits.maxFavoritesPerGroup === 'object') ? limits.maxFavoritesPerGroup : null;
    }
    return groups
      .filter(g => WORLD_TYPES.includes(g.type))
      .map(g => ({
        tag: g.name || '',
        displayName: g.displayName || g.name || '',
        type: g.type,
        visibility: g.visibility || 'private',
        ownerId: g.ownerId || '',
        id: g.id || '',
        capacity: maxPerGroup && typeof maxPerGroup[g.type] === 'number' ? maxPerGroup[g.type] : null,
      }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }

  // 按 tag（worlds2）或 displayName（chill）匹配分组
  function matchGroup(groups, query) {
    if (!query) return null;
    const q = String(query).toLowerCase();
    return groups.find(g => g.tag.toLowerCase() === q)
        || groups.find(g => g.displayName.toLowerCase() === q)
        || null;
  }

  // 分页拉全当前账号全部世界收藏记录（world + vrcPlusWorld 两种类型）
  async function fetchAllWorldFavoriteRecords() {
    const all = [];
    for (const type of WORLD_TYPES) {
      let offset = 0;
      while (true) {
        const data = await api.vrchat.fetch(`/favorites?type=${type}&n=${PAGE}&offset=${offset}`);
        if (!Array.isArray(data) || data.length === 0) break;
        all.push(...data);
        offset += PAGE;
        if (data.length < PAGE) break;
        if (offset >= 3000) break;
      }
    }
    return all;
  }

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

  // 一次性分页拉全收藏世界（含完整详情）。/worlds/favorites 返回顺序即收藏时间倒序（最新在前），
  // 且一次请求即含 name/favorites/visits/popularity/occupants/capacity/tags 等全部字段，
  // 无需再逐个 /worlds/{id} 查详情（原实现首次调用需 15-20 分钟，现为秒级）。
  async function fetchAllFavoriteWorldsFull() {
    const all = [];
    let offset = 0;
    while (true) {
      const data = await api.vrchat.fetch(`/worlds/favorites?n=${PAGE}&offset=${offset}`);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const w of data) {
        all.push({
          worldId: w.id || w.favoriteId || '',
          favoriteGroupName: w.favoriteGroup || '',
          world: w,
        });
      }
      offset += PAGE;
      if (data.length < PAGE) break;
      if (offset >= 3000) break;
    }
    return all;
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
    const groups = await discoverWorldGroups();
    if (tag == null || tag === '') {
      const def = groups.find(g => g.tag === 'worlds0') || groups[0];
      if (!def) throw new Error('未找到可用的世界收藏分组');
      tag = def.tag;
    }
    const group = matchGroup(groups, tag);
    if (!group) {
      const available = groups.map(g => `${g.tag}${g.displayName && g.displayName !== g.tag ? `（${g.displayName}）` : ''}`).join(' / ');
      throw new Error(`收藏分组未找到：${tag}。可用分组: ${available}`);
    }
    const type = worldTypeByTag(group.tag);

    try {
      const data = await api.vrchat.fetch('/favorites', {
        method: 'POST',
        body: { type, favoriteId: worldId, tags: [group.tag] },
      });
      await api.consume('storage.setWorldFavorited', { worldId, favorited: 1 });
      const result = { worldId, favorited: true, tag: group.tag, groupName: group.displayName, type };
      const cached = await api.consume('storage.getWorldName', worldId);
      const name = cached?.name || data?.name || data?.displayName;
      if (name) result.displayName = name;
      api.log(`⭐ 云端收藏: ${worldId} → ${group.tag} (${type})`);
      return result;
    } catch (e) {
      if (e.status >= 400) {
        const msg = typeof e.response?.error?.message === 'string'
          ? e.response.error.message
          : (typeof e.response === 'string' && e.response ? e.response : '');
        return {
          worldId,
          favorited: false,
          tag: group.tag,
          groupName: group.displayName,
          type,
          error: { status: e.status, message: msg || `API error ${e.status}` },
        };
      }
      throw e;
    }
  }

  async function handleUnfavoriteWorld({ worldId, tag, confirm }) {
    if (!worldId || typeof worldId !== 'string' || !worldId.startsWith('wrld_')) {
      throw new Error('worldId is required and must start with wrld_');
    }
    // 解析目标分组（world + vrcPlusWorld 动态发现）
    let targetTag = null;
    if (tag != null && tag !== '') {
      const groups = await discoverWorldGroups();
      const group = matchGroup(groups, tag);
      if (!group) throw new Error(`收藏分组未找到：${tag}（可用 get_my_favorite_groups 查看现有分组）`);
      targetTag = group.tag;
    }

    // 拉全两种类型的世界收藏记录（含 VRC+ 专属），按 worldId + tag 过滤
    const all = await fetchAllWorldFavoriteRecords();
    const records = all.filter(f => f.favoriteId === worldId && (!targetTag || (f.tags || []).includes(targetTag)));
    if (records.length === 0) {
      return { ok: false, worldId, removed: false, error: targetTag ? `该世界不在收藏分组「${targetTag}」中` : '该世界不在任何收藏分组中' };
    }

    if (!confirm) {
      const groupNames = records.map(r => (r.tags || [])[0]).join(', ');
      return { worldId, groupName: groupNames, confirmRequired: true, message: `将从收藏分组「${groupNames}」移除该世界，请传 confirm: true 确认执行` };
    }

    for (const rec of records) {
      try {
        await api.vrchat.fetch(`/favorites/${rec.id}`, { method: 'DELETE' });
      } catch (e) {
        if (e.status !== 404 && e.status !== 400) throw e;
      }
    }
    try {
      await api.consume('storage.setWorldFavorited', { worldId, favorited: 0 });
    } catch { /* 本地标记失败不影响 */ }
    api.log(`✅ unfavorite_world: ${worldId} (${records.length} 条记录)`);
    return { ok: true, worldId, removed: true, removedGroups: records.map(r => (r.tags || [])[0]) };
  }

  async function handleGetMyFavoriteWorlds({ limit = 500, sortBy = 'favorites', group } = {}) {
    try {
      let favs = await fetchAllFavoriteWorldsFull();
      if (group) {
        const groups = await discoverWorldGroups();
        const g = matchGroup(groups, group);
        if (!g) throw new Error(`收藏分组未找到：${group}（可用 get_my_favorite_groups 查看现有分组）`);
        favs = favs.filter(f => f.favoriteGroupName === g.tag);
        api.log(`[favorite-worlds] 按分组过滤: ${g.tag}（${g.displayName}）`);
      }
      if (favs.length === 0) {
        return { ok: true, total: 0, categories: [], worlds: [], message: '没有收藏的世界' };
      }
      api.log(`[favorite-worlds] 收藏世界 ${favs.length} 个（/worlds/favorites 一次拉全）`);

      const ids = favs.map(f => f.worldId).filter(Boolean);

      let zhMap = new Map();
      try {
        zhMap = await api.consume('storage.getZhTranslations', ids);
      } catch { /* 表不存在则跳过 */ }

      const worlds = favs.map((f, idx) => {
        const w = f.world || {};
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
          occupants: typeof w.occupants === 'number' ? w.occupants : null,
          tags: Array.isArray(w.tags) ? w.tags : [],
          category: classify(w),
          favoriteGroup: f.favoriteGroupName || '',
          favOrder: idx,
          cached: false,
        };
      });

      const sorters = {
        favorites: (a, b) => b.favorites - a.favorites,
        visits: (a, b) => b.visits - a.visits,
        name: (a, b) => a.worldName.localeCompare(b.worldName, 'ja'),
        added: (a, b) => a.favOrder - b.favOrder,
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

  async function handleGetMyFavoriteGroups({ type } = {}) {
    try {
      const groups = await discoverWorldGroups(true);
      const filtered = type && WORLD_TYPES.includes(type) ? groups.filter(g => g.type === type) : groups;

      // 统计每组已用数（复用 /worlds/favorites 一次拉全）
      let usedCounts = {};
      try {
        const favs = await fetchAllFavoriteWorldsFull();
        usedCounts = {};
        for (const f of favs) {
          const tag = f.favoriteGroupName || '';
          usedCounts[tag] = (usedCounts[tag] || 0) + 1;
        }
      } catch { /* 统计失败不影响分组列表 */ }

      return {
        ok: true,
        groups: filtered.map(g => ({
          tag: g.tag,
          name: g.displayName,
          type: g.type,
          visibility: g.visibility,
          capacity: g.capacity,
          usedCount: usedCounts[g.tag] || 0,
          id: g.id,
        })),
      };
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

  async function handleMoveWorldGroup({ worldId, toGroup, confirm }) {
    if (!worldId || typeof worldId !== 'string' || !worldId.startsWith('wrld_')) {
      throw new Error('worldId is required and must start with wrld_');
    }
    if (!toGroup) throw new Error('toGroup is required');
    const groups = await discoverWorldGroups();
    const target = matchGroup(groups, toGroup);
    if (!target) throw new Error(`目标分组未找到：${toGroup}（可用 get_my_favorite_groups 查看现有分组）`);
    const all = await fetchAllWorldFavoriteRecords();
    const records = all.filter(f => f.favoriteId === worldId);
    if (records.some(r => (r.tags || []).includes(target.tag))) {
      return { ok: false, worldId, moved: false, error: `该世界已在目标分组「${target.displayName}」中` };
    }
    if (!confirm) {
      const from = records.length > 0 ? records.map(r => (r.tags || [])[0]).join(', ') : '无分组';
      return { worldId, toGroup: target.displayName, toTag: target.tag, fromGroups: records.map(r => (r.tags || [])[0]), confirmRequired: true, message: `将把该世界从「${from}」移动到「${target.displayName}」（删旧建新），请传 confirm: true 确认执行` };
    }
    for (const rec of records) {
      try {
        await api.vrchat.fetch(`/favorites/${rec.id}`, { method: 'DELETE' });
      } catch (e) {
        if (e.status !== 404 && e.status !== 400) throw e;
      }
    }
    await api.vrchat.fetch('/favorites', {
      method: 'POST',
      body: { favoriteId: worldId, tags: [target.tag], type: worldTypeByTag(target.tag) },
    });
    try {
      await api.consume('storage.setWorldFavorited', { worldId, favorited: 1 });
    } catch { /* 本地标记失败不影响 */ }
    api.log(`✅ move_world_group: ${worldId} → ${target.displayName} (${target.type})`);
    return { ok: true, worldId, moved: true, fromGroups: records.map(r => (r.tags || [])[0]), toGroup: target.displayName, toTag: target.tag };
  }

  async function handleUpdateFavoriteGroup({ group, displayName, visibility, confirm }) {
    if (!group) throw new Error('group is required（收藏夹 tag 或 displayName）');
    if (displayName == null && visibility == null) throw new Error('displayName 或 visibility 至少填一个');
    const groups = await discoverWorldGroups(true);
    const g = matchGroup(groups, group);
    if (!g) throw new Error(`收藏分组未找到：${group}（可用 get_my_favorite_groups 查看现有分组）`);
    if (visibility != null && !['friends', 'private', 'public'].includes(visibility)) {
      throw new Error(`visibility 必须是 friends/private/public（当前: ${visibility}）`);
    }
    const body = {};
    if (displayName != null) body.displayName = displayName;
    if (visibility != null) body.visibility = visibility;
    if (!confirm) {
      const parts = [];
      if (displayName != null) parts.push(`displayName → ${displayName}`);
      if (visibility != null) parts.push(`visibility → ${visibility}`);
      const privacyNote = visibility === 'public' ? ' ⚠️ 设为 public 后收藏分组对他人可见' : '';
      return { group: g.displayName, tag: g.tag, type: g.type, changes: { displayName, visibility }, confirmRequired: true, message: `将更新收藏分组「${g.displayName}」：${parts.join('；')}${privacyNote}，请传 confirm: true 确认执行` };
    }
    await api.vrchat.fetch(`/favorite/group/${g.type}/${encodeURIComponent(g.tag)}/${g.ownerId}`, {
      method: 'PUT',
      body,
    });
    api.log(`✅ update_favorite_group: ${g.tag} ${JSON.stringify(body)}`);
    return { ok: true, group: g.displayName, tag: g.tag, type: g.type, updated: body };
  }

  async function handleClearFavoriteGroup({ group, confirm }) {
    if (!group) throw new Error('group is required（收藏夹 tag 或 displayName）');
    const groups = await discoverWorldGroups(true);
    const g = matchGroup(groups, group);
    if (!g) throw new Error(`收藏分组未找到：${group}（可用 get_my_favorite_groups 查看现有分组）`);
    const all = await fetchAllWorldFavoriteRecords();
    const count = all.filter(r => (r.tags || []).includes(g.tag)).length;
    if (!confirm) {
      return { group: g.displayName, tag: g.tag, type: g.type, count, confirmRequired: true, message: `将清空收藏分组「${g.displayName}」内的 ${count} 个收藏（重新收藏可加回），请传 confirm: true 确认执行` };
    }
    if (count === 0) {
      // 空分组无内容可清，直接返回成功（DELETE 端点对空分组报 404 "favorites not found"）
      api.log(`✅ clear_favorite_group: ${g.displayName}（空分组，无需清空）`);
      return { ok: true, group: g.displayName, tag: g.tag, type: g.type, cleared: 0 };
    }
    await api.vrchat.fetch(`/favorite/group/${g.type}/${encodeURIComponent(g.tag)}/${g.ownerId}`, { method: 'DELETE' });
    api.log(`✅ clear_favorite_group: ${g.displayName}（清空 ${count} 条）`);
    return { ok: true, group: g.displayName, tag: g.tag, type: g.type, cleared: count };
  }

  api.registerTool({
    name: 'favorite_world',
    description: '[action·写操作] 把世界加入你的 VRChat 云端收藏夹（POST /favorites，云端写入，调用前请与用户确认）。tag 为收藏分组（worldsN / vrcPlusWorldsN 动态发现，含 VRC+ 专属收藏夹，默认 worlds0；支持传 displayName）。成功后本地 world_cache 标记 favorited=1（供推荐加权）。API 拒绝（如重复收藏）时返回 favorited:false + error，不抛错。',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'VRChat world id (wrld_...)' },
        tag: { type: 'string', description: '收藏夹分组 tag 或 displayName（worlds0/worlds2/vrcPlusWorlds1 等动态发现，默认 worlds0）' },
      },
      required: ['worldId'],
    },
    handler: async (args) => handleFavoriteWorld(args),
  });

  api.registerTool({
    name: 'unfavorite_world',
    description: '[write·收藏] 从收藏分组移除世界（DELETE /favorites/{记录id}，可逆，重新 favorite_world 即可加回）。worldId 必填；tag 可选（省略 = 从全部所在分组移除，含 VRC+ 专属收藏夹）。写操作，confirm: true 才执行，否则只返回预览。',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'VRChat world id (wrld_...)' },
        tag: { type: 'string', description: '收藏夹分组 tag 或 displayName（worldsN / vrcPlusWorldsN，省略 = 从全部所在分组移除）' },
        confirm: { type: 'boolean', description: 'Must be true to actually unfavorite. Default false returns preview only.' },
      },
      required: ['worldId'],
    },
    destructive: true,
    handler: async (args) => handleUnfavoriteWorld(args),
  });

  api.registerTool({
    name: 'move_world_group',
    description: '[write·收藏] 把世界移动到另一收藏分组（删旧建新，与 move_friend_group 同模式；官方客户端 2026.1.1 同款能力）。worldId 必填；toGroup 为分组 tag 或 displayName（含 VRC+ 专属收藏夹）。写操作，confirm: true 才执行。',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'VRChat world id (wrld_...)' },
        toGroup: { type: 'string', description: '目标收藏分组 tag 或 displayName（worldsN / vrcPlusWorldsN）' },
        confirm: { type: 'boolean', description: 'Must be true to actually move. Default false returns preview only.' },
      },
      required: ['worldId', 'toGroup'],
    },
    destructive: true,
    handler: async (args) => handleMoveWorldGroup(args),
  });

  api.registerTool({
    name: 'update_favorite_group',
    description: '[write·收藏] 重命名收藏分组或修改可见性（PUT /favorite/group/{type}/{name}/{userId}）。group 为分组 tag 或 displayName；displayName（新名）/ visibility（friends/private/public）至少填一个。⚠️ 设为 public 会使收藏分组公开可见，隐私敏感，须显式 confirm。写操作，confirm: true 才执行。',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '收藏分组 tag 或 displayName（worldsN / vrcPlusWorldsN）' },
        displayName: { type: 'string', description: '新的分组显示名（重命名）' },
        visibility: { type: 'string', enum: ['friends', 'private', 'public'], description: '可见性：private=仅自己 / friends=好友可见 / public=公开（隐私敏感）' },
        confirm: { type: 'boolean', description: 'Must be true to actually update. Default false returns preview only.' },
      },
      required: ['group'],
    },
    handler: async (args) => handleUpdateFavoriteGroup(args),
  });

  api.registerTool({
    name: 'clear_favorite_group',
    description: '[write·收藏] 清空某收藏分组内全部收藏（DELETE /favorite/group/{type}/{name}/{userId}，语义=清空组内收藏，分组本身保留；重新收藏可加回）。group 为分组 tag 或 displayName。批量删除，destructive，confirm: true 才执行。',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '收藏分组 tag 或 displayName（worldsN / vrcPlusWorldsN）' },
        confirm: { type: 'boolean', description: 'Must be true to actually clear. Default false returns preview only.' },
      },
      required: ['group'],
    },
    destructive: true,
    handler: async (args) => handleClearFavoriteGroup(args),
  });

  api.registerTool({
    name: 'get_my_favorite_worlds',
    description: '[查询·收藏] 拉取当前账号收藏的全部世界（含 VRC+ 专属收藏夹），按标签分类（🎮游戏/👻恐怖/🎵音乐体验/🌄风景观光/🧍Avatar模型/🍻社交聚会/😴休闲睡觉/📷拍照/其他），返回世界名/作者/收藏/浏览/简介/分类。数据经 GET /worlds/favorites 分页一次拉全（含实时 occupants），秒级返回，无需逐个查详情。group 参数可按收藏夹过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '每类返回条数上限，默认 500' },
        sortBy: { type: 'string', enum: ['favorites', 'visits', 'name', 'added'], description: '排序方式（added=按收藏时间倒序，最新添加在前，基于 /favorites 返回顺序；默认 favorites）' },
        group: { type: 'string', description: '按收藏夹过滤（tag 或 displayName，如 vrcPlusWorlds1 / chill，默认全部）' },
      },
    },
    handler: async (args) => handleGetMyFavoriteWorlds(args),
  });

  api.registerTool({
    name: 'get_my_favorite_groups',
    description: '[查询·收藏] 列出当前账号的世界收藏分组（world + vrcPlusWorld 两种类型，含 VRC+ 专属收藏夹），返回 tag/显示名/类型/可见性/容量 capacity（来自 /auth/user/favoritelimits）/已用数/分组 id。type 可选过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['world', 'vrcPlusWorld'], description: '按类型过滤（默认返回全部）' },
      },
    },
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
