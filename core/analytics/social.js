/**
 * 社交分析域：从 Storage 拆出的纯读/分析逻辑。
 *
 * 通过 constructor(storage) 注入 Storage 实例，内部只调用 storage 的
 * 公开/保护方法，不直接触碰 db。这样 Storage 可以继续把公共 API 面
 * 薄转发到这里，而外部调用点无需改动。
 */

export class SocialAnalytics {
  constructor(storage) {
    this.storage = storage;
  }

  // ── 新增：查找同屏好友 ──

  findCompanions(userId, startTime, endTime, includeTimeline = false) {
    // 1. 获取目标用户的时间范围内所有 location 事件
    //    - 查自己：user-location（自己的位置事件）
    //    - 查好友：friend-location（好友的位置事件）
    const userEvents = this.storage.query(
      `SELECT * FROM events WHERE user_id = $userId AND type IN ('user-location', 'friend-location')
       AND created_at >= $start AND created_at <= $end
       ORDER BY created_at ASC`,
      { $userId: userId, $start: startTime, $end: endTime }
    );

    // 2. 提取用户去过的所有 unique instanceId
    //    默认不组装 userTimeline（全量位置事件可能数百上千条，导致 MCP 输出过大被截断），
    //    仅在 includeTimeline=true 时才收集，满足需要逐条查看位置明细的场景。
    const userInstances = new Set();
    const userTimeline = includeTimeline ? [] : null;
    for (const ev of userEvents) {
      let location = '';
      try {
        const cj = JSON.parse(ev.content_json);
        location = cj.location || '';
      } catch {}
      if (location && location !== 'offline' && location !== 'traveling') {
        const parts = location.split(':');
        const worldId = parts[0];
        const instanceId = parts.slice(1).join(':');
        if (worldId && instanceId) {
          userInstances.add(instanceId);
          userInstances.add(`${worldId}:${instanceId}`);
        }
        if (includeTimeline) {
          userTimeline.push({
            id: ev.id,
            created_at: ev.created_at,
            type: ev.type,
            world_id: worldId,
            instance_id: instanceId,
            world_name: ev.world_name || '',
            content_json: ev.content_json,
          });
        }
      } else if (includeTimeline) {
        userTimeline.push({
          id: ev.id,
          created_at: ev.created_at,
          type: ev.type,
          world_id: location || 'offline',
          instance_id: null,
          world_name: ev.world_name || '',
          content_json: ev.content_json,
        });
      }
    }

    // 3. 获取所有好友在时间范围内的 friend-location 事件
    const friendEvents = this.storage.query(
      `SELECT * FROM events WHERE type = 'friend-location'
       AND created_at >= $start AND created_at <= $end
       ORDER BY created_at ASC`,
      { $start: startTime, $end: endTime }
    );

    // 4. 交叉匹配（排除目标用户本人——查好友时 TA 自己的 friend-location 也会进 friendEvents）
    const matchedMap = new Map();
    for (const ev of friendEvents) {
      if (ev.user_id === userId) continue;
      let location = '';
      try {
        const cj = JSON.parse(ev.content_json);
        location = cj.location || '';
      } catch {}
      if (!location || location === 'offline' || location === 'traveling') continue;

      const parts = location.split(':');
      const worldId = parts[0];
      const instanceId = parts.slice(1).join(':');
      const key = `${worldId}:${instanceId}`;

      if (userInstances.has(instanceId) || userInstances.has(key)) {
        if (!matchedMap.has(ev.user_id)) {
          matchedMap.set(ev.user_id, {
            displayName: ev.display_name,
            events: [],
          });
        }
        matchedMap.get(ev.user_id).events.push({
          id: ev.id,
          created_at: ev.created_at,
          type: ev.type,
          world_id: worldId,
          instance_id: instanceId,
          world_name: ev.world_name || '',
        });
      }
    }

    // 5. 整理输出
    const companions = [];
    for (const [uid, info] of matchedMap) {
      const times = info.events.map(e => e.created_at).sort();
      const worlds = new Set(info.events.map(e => e.world_name || e.world_id));
      companions.push({
        userId: uid,
        displayName: info.displayName,
        firstSeen: times[0],
        lastSeen: times[times.length - 1],
        matchCount: info.events.length,
        worlds: [...worlds].filter(Boolean),
      });
    }

    companions.sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1));

    return {
      userId,
      timeRange: { start: startTime, end: endTime },
      userInstanceCount: userInstances.size,
      userTimeline: userTimeline || [],
      companionCount: companions.length,
      companions,
    };
  }

  // ── 新增：查询两个好友（任意第三方）之间的同屏次数与时长 ──
  //
  // 精确口径（时间窗口 + 可识别实例）：
  //   friend-location 是位置快照事件，无法可靠重建「在场区间」。改为：
  //   对好友 B 的每条有效实例事件，找好友 A 在「同一实例」且时间戳在 ±window
  //   内的匹配事件对，作为一次同屏。
  //   排除 offline/traveling/private —— private 无房主信息，不同人不同时间的
  //   private 会被误判为同一房间（实测坑），故不计。
  //   limit 仅限制返回的 matches 条数，不改变 matchCount/总时长的统计口径。
  findFriendPairScreen(userIdA, userIdB, startTime, endTime, windowMinutes = 30, limit = null) {
    const { pairs, instRanges } = this._collectPairScreen(userIdA, userIdB, startTime, endTime, windowMinutes);

    // 按世界拆分时长：同一 world 的实例时长求和（段首到段尾，不断开）
    const worldNames = this._resolveWorldNames([...new Set(pairs.map(p => p.world_id))]);
    const worldMinutes = new Map();
    let totalSeconds = 0;
    for (const [, range] of instRanges) {
      const secs = Math.max(0, (range.max - range.min) / 1000);
      totalSeconds += secs;
      const wname = worldNames.get(range.world_id) || range.world_id;
      worldMinutes.set(wname, (worldMinutes.get(wname) || 0) + secs / 60);
    }
    const worldDuration = [...worldMinutes.entries()]
      .map(([world, minutes]) => ({ world, minutes: Math.round(minutes * 10) / 10 }))
      .sort((a, b) => b.minutes - a.minutes);

    const worlds = [...worldNames.values()].filter(Boolean);
    const limited = limit ? pairs.slice(0, limit) : pairs;
    const matches = limited.map(p => ({ ...p, world_name: worldNames.get(p.world_id) || '' }));

    const names = this._getDisplayNames([userIdA, userIdB]);

    return {
      userIdA,
      userIdB,
      displayNameA: names[userIdA],
      displayNameB: names[userIdB],
      timeRange: { start: startTime, end: endTime },
      windowMinutes,
      matchCount: pairs.length,
      totalSeconds: Math.round(totalSeconds),
      totalMinutes: Math.round(totalSeconds / 60 * 10) / 10,
      worldDuration,
      worlds: [...worlds].filter(Boolean),
      matches,
      limit,
    };
  }

  // ── 新增：查询两个好友之间的「每次见面」时段（单次见面时长）──
  //
  // 按实例切分：同一实例内所有「同屏匹配」事件合并为一次见面，给出段首/段尾/时长。
  // 复用 _collectPairScreen 的精确匹配口径（同实例 + 时间差 ≤ windowMinutes，
  // 排除 private/offline/traveling）。
  findFriendPairMeetings(userIdA, userIdB, startTime, endTime, windowMinutes = 30) {
    const { instRanges } = this._collectPairScreen(userIdA, userIdB, startTime, endTime, windowMinutes);

    const meetings = [...instRanges.entries()].map(([key, range]) => {
      const worldId = key.split(':')[0];
      const instanceId = key.slice(worldId.length + 1);
      return {
        worldId,
        instanceId,
        startTime: new Date(range.min).toISOString(),
        endTime: new Date(range.max).toISOString(),
        durationMinutes: Math.round((range.max - range.min) / 60000),
      };
    });
    meetings.sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));

    return {
      userIdA,
      userIdB,
      meetingCount: meetings.length,
      totalDurationSeconds: meetings.reduce((s, m) => s + m.durationMinutes * 60, 0),
      meetings,
    };
  }

  // ── 公共 helper：好友对同屏匹配收集（get_friend_pair_screen / get_friend_pair_meeting 共用）──
  // 返回 { pairs, instRanges }：
  //   pairs      所有匹配事件对（B 事件 × A 同实例接近事件），按 bt 升序
  //   instRanges 每实例的段首(min)/段尾(max)/world_id（段首到段尾，不断开）
  _collectPairScreen(userIdA, userIdB, startTime, endTime, windowMinutes = 30) {
    const getEvents = (uid) => this.storage.query(
      `SELECT created_at, json_extract(content_json, '$.location') AS loc FROM events
       WHERE user_id = $u AND type = 'friend-location'
       AND created_at >= $start AND created_at <= $end`,
      { $u: uid, $start: startTime, $end: endTime }
    );

    const parse = (loc) => {
      if (!loc || loc === 'offline' || loc === 'traveling') return null;
      const parts = loc.split(':');
      const worldId = parts[0];
      const instanceId = parts.slice(1).join(':');
      // private 无房主标识，无法判定是否同一房间，排除
      if (instanceId === 'private') return null;
      if (!worldId || !instanceId) return null;
      return { world_id: worldId, instance_id: instanceId };
    };

    const winMs = Math.max(1, windowMinutes) * 60000;
    const aEvents = getEvents(userIdA).map(r => ({ t: r.created_at, ...(parse(r.loc) || {}) })).filter(e => e.world_id);
    const bEvents = getEvents(userIdB).map(r => ({ t: r.created_at, ...(parse(r.loc) || {}) })).filter(e => e.world_id);

    const aByInst = new Map();
    for (const e of aEvents) {
      const k = `${e.world_id}:${e.instance_id}`;
      if (!aByInst.has(k)) aByInst.set(k, []);
      aByInst.get(k).push(e.t);
    }

    const pairs = [];
    const instRanges = new Map(); // key -> { world_id, instance_id, min, max }
    const seen = new Set();
    for (const be of bEvents) {
      const k = `${be.world_id}:${be.instance_id}`;
      const ats = aByInst.get(k);
      if (!ats) continue;
      const bt = Date.parse(be.t);
      for (const at of ats) {
        if (Math.abs(Date.parse(at) - bt) > winMs) continue;
        const pairId = `${be.t}|${at}`;
        if (seen.has(pairId)) continue;
        seen.add(pairId);
        pairs.push({ at, bt: be.t, world_id: be.world_id, instance_id: be.instance_id });
        const tA = Date.parse(at);
        const cur = instRanges.get(k) || { world_id: be.world_id, instance_id: be.instance_id, min: Infinity, max: -Infinity };
        cur.min = Math.min(cur.min, tA, bt);
        cur.max = Math.max(cur.max, tA, bt);
        instRanges.set(k, cur);
      }
    }
    pairs.sort((a, b) => (a.bt < b.bt ? -1 : 1));

    return { pairs, instRanges };
  }

  // ── 公共 helper：批量解析世界名（避免 N+1）──
  _resolveWorldNames(worldIds) {
    const out = new Map();
    const ids = [...new Set(worldIds.filter(Boolean))];
    if (ids.length === 0) return out;
    const ph = ids.map((_, i) => `$w${i}`).join(',');
    const params = {};
    ids.forEach((w, i) => { params[`$w${i}`] = w; });
    const rows = this.storage.query(
      `SELECT world_id, world_name FROM events WHERE world_id IN (${ph}) AND world_name != ''
       GROUP BY world_id, world_name ORDER BY MAX(created_at) DESC`,
      params
    );
    for (const r of rows) {
      if (!out.has(r.world_id)) out.set(r.world_id, r.world_name);
    }
    return out;
  }

  // ── 公共 helper：批量解析显示名（最近一条）──
  _getDisplayNames(userIds) {
    const out = {};
    for (const uid of userIds) {
      const rows = this.storage.query(
        `SELECT display_name FROM events WHERE user_id = $uid AND display_name != '' ORDER BY created_at DESC LIMIT 1`,
        { $uid: uid }
      );
      out[uid] = rows.length ? rows[0].display_name : '';
    }
    return out;
  }

  // ── 新增：分析好友上线规律 ──

  getOnlinePattern(userId, { startTime, endTime, days } = {}) {
    let start, end, windowDays;
    if (startTime && endTime) {
      start = startTime;
      end = endTime;
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new Error('Invalid startTime or endTime');
      }
      if (startMs > endMs) {
        throw new Error('startTime must be <= endTime');
      }
      windowDays = Math.max(1, Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)));
    } else {
      const effectiveDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 30;
      const now = new Date();
      const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const beijingDateStr = beijingNow.toISOString().slice(0, 10);
      const endDate = new Date(`${beijingDateStr}T23:59:59.999+08:00`);
      const startDate = new Date(`${beijingDateStr}T00:00:00.000+08:00`);
      startDate.setDate(startDate.getDate() - effectiveDays + 1);
      start = startDate.toISOString();
      end = endDate.toISOString();
      windowDays = effectiveDays;
    }

    const rows = this.storage.query(
      `SELECT * FROM events WHERE user_id = $userId
       AND (
         type LIKE 'friend-online%' OR type LIKE 'user-online%'
         OR type LIKE 'friend-offline%' OR type LIKE 'user-offline%'
         OR type LIKE 'friend-location%' OR type LIKE 'user-location%'
       )
       AND created_at >= $start AND created_at <= $end
       ORDER BY created_at ASC`,
      { $userId: userId, $start: start, $end: end }
    );

    const hourly = { online: {}, offline: {}, location: {} };
    const activeDatesSet = new Set();
    let displayName = '';

    for (const ev of rows) {
      if (!displayName && ev.display_name) displayName = ev.display_name;
      const date = new Date(ev.created_at);
      if (Number.isNaN(date.getTime())) continue;
      const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
      const hour = String(beijingDate.getUTCHours());
      const dateStr = beijingDate.toISOString().slice(0, 10);
      activeDatesSet.add(dateStr);

      if (ev.type.endsWith('-online')) {
        hourly.online[hour] = (hourly.online[hour] || 0) + 1;
      } else if (ev.type.endsWith('-offline')) {
        hourly.offline[hour] = (hourly.offline[hour] || 0) + 1;
      } else if (ev.type.endsWith('-location')) {
        hourly.location[hour] = (hourly.location[hour] || 0) + 1;
      }
    }

    if (!displayName) {
      const friend = this.storage.getFriend(userId);
      if (friend) displayName = friend.display_name || '';
    }

    const total = {
      online: Object.values(hourly.online).reduce((a, b) => a + b, 0),
      offline: Object.values(hourly.offline).reduce((a, b) => a + b, 0),
      location: Object.values(hourly.location).reduce((a, b) => a + b, 0),
      activeDays: activeDatesSet.size,
    };

    const sortedDates = [...activeDatesSet].sort((a, b) => (a < b ? -1 : 1));
    const activeDates = [...sortedDates].reverse();

    const gaps = [];
    for (let i = 1; i < sortedDates.length; i++) {
      const diff = (new Date(sortedDates[i]) - new Date(sortedDates[i - 1])) / (24 * 60 * 60 * 1000);
      gaps.push(diff);
    }
    const avgGapDays = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const longestGapDays = gaps.length > 0 ? Math.max(...gaps) : 0;

    const endMs = Date.parse(end);
    const last30Start = new Date(endMs - 30 * 24 * 60 * 60 * 1000);
    const last30ActiveDays = [...activeDatesSet].filter(d => {
      const t = new Date(d).getTime();
      return t >= last30Start.getTime() && t <= endMs;
    }).length;

    const frequency = {
      windowDays,
      activeDays: activeDatesSet.size,
      activityRatio: windowDays > 0 ? activeDatesSet.size / windowDays : 0,
      last30ActiveDays,
      avgGapDays,
      longestGapDays,
    };

    function peakHour(dist) {
      let bestHour = null;
      let bestCount = -1;
      for (const [h, c] of Object.entries(dist)) {
        if (c > bestCount) {
          bestCount = c;
          bestHour = Number(h);
        }
      }
      return bestHour;
    }

    const loginPeakHour = peakHour(hourly.online);
    const activePeakHour = peakHour(hourly.location);
    const offlinePeakHour = peakHour(hourly.offline);

    function formatSuggestedWindow(h1, h2) {
      if (h1 === null && h2 === null) return null;
      if (h1 === null) return `${h2}:00`;
      if (h2 === null) return `${h1}:00`;
      if (h1 === h2) return `${h1}:00`;
      if (Math.abs(h1 - h2) === 1) return `${Math.min(h1, h2)}:00-${Math.max(h1, h2)}:00`;
      return `${h1}:00/${h2}:00`;
    }

    const suggestedWindow = formatSuggestedWindow(loginPeakHour, activePeakHour);

    return {
      userId,
      displayName,
      window: { start, end, days: windowDays },
      total,
      hourly,
      activeDates,
      frequency,
      peak: {
        loginPeakHour,
        activePeakHour,
        offlinePeakHour,
        suggestedWindow,
      },
    };
  }

  // ── 周报专用方法 ──

  getOwnWorldSessions(startTime, endTime) {
    const rows = this.storage.query(
      `SELECT content_json, created_at FROM events WHERE type='user-location' AND created_at >= $start AND created_at <= $end ORDER BY created_at ASC`,
      { $start: startTime, $end: endTime }
    );
    const sessions = []; // {worldId, start, end, minutes}
    let curWorld = null, curStart = null;
    for (const row of rows) {
      let loc = '';
      try { loc = JSON.parse(row.content_json).location || ''; } catch {}
      const dt = row.created_at;
      if (loc.startsWith('wrld_')) {
        const wid = loc.split(':')[0];
        if (curWorld && wid !== curWorld) {
          sessions.push({ worldId: curWorld, start: curStart, end: dt });
        }
        curWorld = wid; curStart = dt;
      } else {
        if (curWorld) { sessions.push({ worldId: curWorld, start: curStart, end: dt }); curWorld = null; }
      }
    }
    if (curWorld) sessions.push({ worldId: curWorld, start: curStart, end: rows.length ? rows[rows.length-1].created_at : curStart });
    // 过滤 <3 分钟的跳转会话，计算 minutes
    return sessions.filter(s => (Date.parse(s.end) - Date.parse(s.start)) / 60000 >= 3)
      .map(s => ({ ...s, minutes: (Date.parse(s.end) - Date.parse(s.start)) / 60000 }));
  }

  getWeeklyCompanions(userId, startTime, endTime) {
    // startTime/endTime 为 UTC ISO；按北京自然日（UTC 16:00 日界）切分
    const BJ_OFFSET = 8 * 3600 * 1000;
    const startMs = Date.parse(startTime), endMs = Date.parse(endTime);
    const merged = new Map();

    // 对齐到北京天边界：北京 00:00 = UTC 16:00 前一天
    let dayStart = Math.floor((startMs + BJ_OFFSET) / 86400000) * 86400000 - BJ_OFFSET;

    while (dayStart < endMs) {
      const dayEnd = Math.min(dayStart + 86400000, endMs);
      const utcDayStart = new Date(dayStart).toISOString();
      const utcDayEnd = new Date(dayEnd).toISOString();
      const r = this.findCompanions(userId, utcDayStart, utcDayEnd);
      const dayLabel = new Date(dayStart + BJ_OFFSET).toISOString().slice(5, 10); // MM-DD 北京
      for (const c of (r.companions || [])) {
        if (!merged.has(c.userId)) {
          merged.set(c.userId, { displayName: c.displayName, matchCount: 0, days: new Set(), dayCounts: {}, worlds: new Set() });
        }
        const m = merged.get(c.userId);
        m.matchCount += c.matchCount || 0;
        m.days.add(dayLabel);
        // 按北京日累计同屏次数（供周报每日足迹展示）
        m.dayCounts[dayLabel] = (m.dayCounts[dayLabel] || 0) + (c.matchCount || 0);
        for (const w of (c.worlds || [])) m.worlds.add(w);
      }
      dayStart += 86400000;
    }
    return merged;
  }

  getFriendGroupStats(startTime, endTime) {
    const rows = this.storage.query(
      `SELECT content_json FROM events WHERE type='friend-location'
       AND (content_json LIKE '%~group(grp_%' OR content_json LIKE '%~group(gmem_%')
       AND created_at >= $start AND created_at <= $end`,
      { $start: startTime, $end: endTime }
    );
    const stats = new Map(); // groupId -> {count, users:Set, worlds:Set}
    for (const row of rows) {
      try {
        const c = JSON.parse(row.content_json);
        const loc = c.location || '';
        // VRChat 群组 ID 已从 grp_ 迁移为 gmem_ (2026-08 实测), 两种前缀都匹配
        const m = loc.match(/~group\((grp_[a-f0-9-]+|gmem_[a-f0-9-]+)\)/);
        if (m && loc.startsWith('wrld_')) {
          const gid = m[1];
          if (!stats.has(gid)) stats.set(gid, { count: 0, users: new Set(), worlds: new Set() });
          const s = stats.get(gid);
          s.count++; s.users.add(c.userId || ''); s.worlds.add(loc.split(':')[0]);
        }
      } catch {}
    }
    return stats;
  }
}
