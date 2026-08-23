export default function register(api) {
  async function handleGetUserGroups({ userId, withDetails }) {
    let targetId = userId;
    if (!targetId) {
      const me = await api.vrchat.fetch('/auth/user');
      targetId = me?.id;
    }
    if (!targetId) throw new Error('Unable to determine target user id');
    const data = await api.vrchat.fetch(`/users/${targetId}/groups`);
    const groups = (data || []).map((g) => {
      const item = {};
      if (g.groupId !== undefined && g.groupId !== null) item.groupId = g.groupId;
      if (g.name !== undefined && g.name !== null) item.name = g.name;
      if (g.shortCode !== undefined && g.shortCode !== null) item.shortCode = g.shortCode;
      if (g.memberCount !== undefined && g.memberCount !== null) item.memberCount = g.memberCount;
      if (g.isVerified !== undefined && g.isVerified !== null) item.isVerified = g.isVerified;
      if (g.myRank !== undefined && g.myRank !== null) {
        item.myRank = typeof g.myRank === 'object' ? (g.myRank.id || null) : g.myRank;
      }
      return item;
    });
    if (withDetails && groups.length > 0) {
      const CONCURRENCY = 5;
      let idx = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, groups.length) }, async () => {
        while (idx < groups.length) {
          const i = idx++;
          const g = groups[i];
          try {
            const d = await api.vrchat.fetch(`/groups/${g.groupId}`);
            if (d) {
              if (d.description) g.description = d.description;
              if (d.isVerified !== undefined && d.isVerified !== null) g.isVerified = d.isVerified;
            }
          } catch (e) { /* 单群失败忽略 */ }
        }
      });
      await Promise.all(workers);
    }
    return { userId: targetId, count: groups.length, groups };
  }

  async function handleGetGroupInfo({ groupId, includeAnnouncement }) {
    if (!groupId) throw new Error('groupId is required');
    const d = await api.vrchat.fetch(`/groups/${groupId}`);
    const result = { groupId: d.id };
    if (d.name !== undefined && d.name !== null) result.name = d.name;
    if (d.shortCode !== undefined && d.shortCode !== null) result.shortCode = d.shortCode;
    if (d.memberCount !== undefined && d.memberCount !== null) result.memberCount = d.memberCount;
    if (d.isVerified !== undefined && d.isVerified !== null) result.isVerified = d.isVerified;
    if (d.description !== undefined && d.description !== null) result.description = d.description;
    if (d.discordId !== undefined && d.discordId !== null) result.discordId = d.discordId;
    if (d.bannerId !== undefined && d.bannerId !== null) result.bannerId = d.bannerId;
    if (d.tags !== undefined && d.tags !== null) result.tags = d.tags;
    if (d.joinState !== undefined && d.joinState !== null) result.joinState = d.joinState;
    if (d.allowGroupJoinPrompt !== undefined && d.allowGroupJoinPrompt !== null) result.allowGroupJoinPrompt = d.allowGroupJoinPrompt;
    if (includeAnnouncement) {
      try {
        const a = await api.vrchat.fetch(`/groups/${groupId}/announcement`);
        if (a && typeof a === 'object' && a.text) {
          result.announcement = {
            id: a.id, title: a.title, text: a.text,
            authorId: a.authorId, createdAt: a.createdAt,
            updatedAt: a.updatedAt, visibility: a.visibility,
          };
        } else {
          result.announcement = null;
        }
      } catch (e) {
        result.announcement = null;
      }
    }
    return result;
  }

  async function handleGetGroupInstances({ groupId }) {
    if (!groupId) throw new Error('groupId is required');
    const data = await api.vrchat.fetch(`/groups/${groupId}/instances`);
    const instances = (data || []).map((inst) => ({
      instanceId: inst.instanceId,
      location: inst.location,
      memberCount: inst.memberCount,
      worldId: inst.world?.id || null,
      worldName: inst.world?.name || null,
      worldAuthor: inst.world?.authorName || null,
      worldCapacity: inst.world?.capacity || null,
      worldImageUrl: inst.world?.imageUrl || null,
    }));
    return { groupId, count: instances.length, instances };
  }

  async function handleGetGroupAnnouncement({ groupId }) {
    if (!groupId) throw new Error('groupId is required');
    try {
      const d = await api.vrchat.fetch(`/groups/${groupId}/announcement`);
      if (!d || typeof d !== 'object' || !d.text) {
        return { groupId, announcement: null };
      }
      return {
        groupId,
        announcement: {
          id: d.id,
          title: d.title,
          text: d.text,
          authorId: d.authorId,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          visibility: d.visibility,
          imageUrl: d.imageUrl,
        },
      };
    } catch (e) {
      if (e.status === 403 || e.status === 404) return { groupId, announcement: null };
      throw e;
    }
  }

  async function handleSearchGroups({ query, n }) {
    if (!query || typeof query !== 'string') throw new Error('query is required');
    const limit = Math.min(Math.max(parseInt(n, 10) || 30, 1), 100);
    const data = await api.vrchat.fetch(`/groups?query=${encodeURIComponent(query)}&n=${limit}`);
    const groups = (data || []).map((g) => {
      const item = {};
      if (g.id !== undefined && g.id !== null) item.groupId = g.id;
      if (g.name !== undefined && g.name !== null) item.name = g.name;
      if (g.shortCode !== undefined && g.shortCode !== null) item.shortCode = g.shortCode;
      if (g.memberCount !== undefined && g.memberCount !== null) item.memberCount = g.memberCount;
      if (g.isVerified !== undefined && g.isVerified !== null) item.isVerified = g.isVerified;
      if (g.description !== undefined && g.description !== null) item.description = g.description;
      return item;
    });
    return { query, count: groups.length, groups };
  }

  async function handleJoinGroup({ groupId }) {
    if (!groupId) throw new Error('groupId is required');
    try {
      const data = await api.vrchat.fetch(`/groups/${groupId}/join`, { method: 'POST' });
      return { groupId, joined: true, membership: data?.membershipId ? { membershipId: data.membershipId } : undefined };
    } catch (e) {
      if (e.status === 400 && typeof e.response?.error?.message === 'string' && e.response.error.message.includes('already a member')) {
        return { groupId, joined: false, alreadyMember: true };
      }
      throw e;
    }
  }

  async function handleLeaveGroup({ groupId, confirm }) {
    if (!groupId) throw new Error('groupId is required');
    if (confirm !== true) {
      return { groupId, confirmRequired: true, message: 'Leaving a group removes you from it. Pass confirm: true to actually leave.' };
    }
    try {
      await api.vrchat.fetch(`/groups/${groupId}/leave`, { method: 'POST' });
      return { groupId, left: true };
    } catch (e) {
      if (e.status === 403 || e.status === 404 || e.status === 400) return { groupId, left: false, notMember: true };
      throw e;
    }
  }

  async function handlePeekGroupAnnouncement({ groupId, confirm }) {
    if (!groupId) throw new Error('groupId is required');
    if (confirm !== true) {
      return { groupId, confirmRequired: true, message: 'This auto-joins the group, reads its announcement, then leaves (members see the join feed). Pass confirm: true to proceed.' };
    }
    const g = await api.vrchat.fetch(`/groups/${groupId}`);
    const joinState = g?.joinState;
    if (joinState !== 'open') {
      return { groupId, joinState: joinState || 'unknown', peekable: false,
               message: joinState === 'request' ? 'Group requires request/approval - cannot auto-join.' :
                        joinState === 'invite' ? 'Group is invite-only - cannot auto-join.' : 'Group join state unknown.' };
    }
    let joinedNow = false;
    try {
      await api.vrchat.fetch(`/groups/${groupId}/join`, { method: 'POST' });
      joinedNow = true;
    } catch (e) {
      if (!(e.status === 400 && typeof e.response?.error?.message === 'string' && e.response.error.message.includes('already a member'))) {
        throw new Error(`join failed: ${e.status}`);
      }
    }
    try {
      const a = await api.vrchat.fetch(`/groups/${groupId}/announcement`);
      let announcement = null;
      if (a && typeof a === 'object' && a.text) {
        announcement = {
          id: a.id, title: a.title, text: a.text,
          authorId: a.authorId, createdAt: a.createdAt,
          updatedAt: a.updatedAt, visibility: a.visibility,
        };
      }
      return { groupId, joinState, peekable: true, joinedNow, announcement };
    } finally {
      if (joinedNow) {
        try { await api.vrchat.fetch(`/groups/${groupId}/leave`, { method: 'POST' }); } catch (e) { /* 退出失败忽略 */ }
      }
    }
  }

  async function handleGetGroupHeat({ days, startTime, endTime, topK = 5 }) {
    let start, end;
    if (startTime && endTime) {
      start = new Date(startTime).toISOString();
      end = new Date(endTime).toISOString();
    } else {
      const n = Math.min(Math.max(parseInt(days, 10) || 7, 1), 30);
      const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const todayStr = bjNow.toISOString().slice(0, 10);
      end = new Date(`${todayStr}T23:59:59.999+08:00`).toISOString();
      const first = new Date(`${todayStr}T00:00:00.000+08:00`);
      first.setUTCDate(first.getUTCDate() - (n - 1));
      start = new Date(`${first.toISOString().slice(0, 10)}T00:00:00.000+08:00`).toISOString();
    }
    const winLen = Date.parse(end) - Date.parse(start);
    if (!(winLen > 0)) throw new Error('Invalid time window');
    const prevStart = new Date(Date.parse(start) - winLen).toISOString();

    const groups = await api.consume('storage.getGroupHeat', start, end);
    const prev = await api.consume('storage.getGroupHeat', prevStart, start);

    const ranked = [...groups.entries()].map(([gid, s]) => {
      const prevCount = prev.has(gid) ? prev.get(gid).count : 0;
      const deltaPct = prevCount === 0
        ? (s.count > 0 ? 100 : 0)
        : Math.round(((s.count - prevCount) / prevCount) * 100);
      return {
        groupId: gid,
        name: '',
        memberCount: 0,
        activityCount: s.count,
        friendCount: s.users.size,
        worldCount: s.worlds.size,
        prevActivityCount: prevCount,
        trendPct: deltaPct,
      };
    }).sort((a, b) => b.activityCount - a.activityCount);

    const k = Math.min(Math.max(parseInt(topK, 10) || 5, 1), 10);
    const backfillN = Math.min(ranked.length, Math.max(10, k * 2));
    const backfillIds = new Set(ranked.slice(0, backfillN).map((g) => g.groupId));
    const cachedGids = [];
    for (const g of ranked) {
      if (!backfillIds.has(g.groupId)) continue;
      const cached = await api.consume('storage.getGroupCached', g.groupId);
      if (cached && cached.name) {
        g.name = cached.name;
        g.memberCount = cached.member_count || 0;
        cachedGids.push(g.groupId);
      }
    }
    const missing = ranked.filter((g) => backfillIds.has(g.groupId) && !cachedGids.includes(g.groupId));
    for (const g of missing) {
      try {
        const d = await api.vrchat.fetch(`/groups/${g.groupId}`);
        if (d) {
          g.name = d.name || g.groupId;
          g.memberCount = d.memberCount || 0;
          await api.consume('storage.upsertGroupCache', {
            groupId: g.groupId, name: d.name || '', description: d.description || '',
            memberCount: d.memberCount || 0,
          });
        } else g.name = g.groupId;
      } catch { g.name = g.groupId; }
    }
    const heatmap = {};
    const rankByName = new Map(ranked.map((g) => [g.groupId, g.name]));
    for (const [gid, s] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, k)) {
      const cells = {};
      for (const [key, count] of s.hourly) {
        const [dow, hour] = key.split(':');
        if (!cells[dow]) cells[dow] = {};
        cells[dow][hour] = count;
      }
      heatmap[gid] = { name: rankByName.get(gid) || gid, cells };
    }

    return {
      window: { start, end, prevStart },
      totalActivity: ranked.reduce((a, g) => a + g.activityCount, 0),
      groupCount: ranked.length,
      groups: ranked,
      heatmap,
    };
  }

  api.registerTool({
    name: 'get_user_groups',
    description: '[group] List groups a user has joined (default: current account). withDetails=true also fetches descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...); omit to use the authenticated account' },
        withDetails: { type: 'boolean', description: 'When true, also fetch each group\'s description (slower, ~1 req/group; failures skipped)' },
      },
    },
    handler: async (args) => handleGetUserGroups(args),
  });

  api.registerTool({
    name: 'get_group_info',
    description: '[group] Get a VRChat group\'s details (name, member count, description, verified status). includeAnnouncement=true also fetches the announcement.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
        includeAnnouncement: { type: 'boolean', description: 'When true, also fetch the group announcement (null if none / not a member)' },
      },
      required: ['groupId'],
    },
    handler: async (args) => handleGetGroupInfo(args),
  });

  api.registerTool({
    name: 'get_group_instances',
    description: '[group] List a group\'s currently open group instances (rooms). Empty array = no rooms open.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
      },
      required: ['groupId'],
    },
    handler: async (args) => handleGetGroupInstances(args),
  });

  api.registerTool({
    name: 'get_group_announcement',
    description: '[group] Get a group\'s announcement post (title/text/author/createdAt). null if none or not a member.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
      },
      required: ['groupId'],
    },
    handler: async (args) => handleGetGroupAnnouncement(args),
  });

  api.registerTool({
    name: 'get_group_heat',
    description: '[query·热度] Group activity heat: rank groups by how much your friends/you were in their group rooms (activityCount, friendCount, worldCount, trendPct vs previous equal window) + day-of-week×hour Beijing-time heatmap for top groups. Data from local event history (supports grp_/gmem_ ids).',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', default: 7, description: 'Analyze last N days (Beijing natural days, default 7, max 30)' },
        startTime: { type: 'string', description: 'ISO 8601 start (optional, overrides days)' },
        endTime: { type: 'string', description: 'ISO 8601 end (optional, must pair with startTime)' },
        topK: { type: 'number', default: 5, description: 'Number of top groups to include a heatmap for (default 5, max 10)' },
      },
    },
    handler: async (args) => handleGetGroupHeat(args),
  });

  api.registerTool({
    name: 'search_groups',
    description: '[group] Search VRChat groups by name. Returns matching groups (query param; API requires query, NOT search).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Group name keyword (supports Chinese/Japanese/English)' },
        n: { type: 'number', description: 'Max results (default 30, max 100)' },
      },
      required: ['query'],
    },
    handler: async (args) => handleSearchGroups(args),
  });

  api.registerTool({
    name: 'join_group',
    description: '[group] Join a group. Open groups join instantly; 400 already-member is returned as alreadyMember:true (no error).',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
      },
      required: ['groupId'],
    },
    handler: async (args) => handleJoinGroup(args),
  });

  api.registerTool({
    name: 'leave_group',
    description: '[group] Leave a group (removes your membership). Requires confirm: true. 404 non-member returns notMember:true.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
        confirm: { type: 'boolean', description: 'Must be true to actually leave; otherwise returns preview only' },
      },
      required: ['groupId'],
    },
    destructive: true,
    handler: async (args) => handleLeaveGroup(args),
  });

  api.registerTool({
    name: 'peek_group_announcement',
    description: '[group] Peek a group announcement: joins if joinState=open, reads announcement, then leaves. Non-open groups return peekable:false.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
        confirm: { type: 'boolean', description: 'Must be true to auto-join (members see the join feed)' },
      },
      required: ['groupId'],
    },
    handler: async (args) => handlePeekGroupAnnouncement(args),
  });
}
