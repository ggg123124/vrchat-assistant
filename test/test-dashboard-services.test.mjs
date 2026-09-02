/**
 * test-dashboard-services.test.mjs — dashboard.* 核心数据服务无凭据测试（CI 可用）
 *
 * 覆盖 registerDashboardServices 注册的服务返回形状与关键字段：
 *   trackedNonFriends / trackedChanges（bio/status 前后值）/ stats / owner 归属
 * 自包含：临时 SQLite + 造数据，不依赖真实 VRChat 凭据。
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO = path.join(__dirname, '..');

const { ctx } = await import(pathToFileURL(path.join(REPO, 'core', 'server-context.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);
const { registerDashboardServices } = await import(pathToFileURL(path.join(REPO, 'core', 'dashboard-services.js')).href);
const { avatarFileId } = await import(pathToFileURL(path.join(REPO, 'core', 'img-util.js')).href);

// ── 临时 DB + 运行时准备 ──
const tmpDb = path.join(__dirname, 'test-dash-services.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

const services = new Map();
const serviceOwners = new Map();
const loader = { services, serviceOwners };

ctx.storage = new Storage();
await ctx.storage.init(tmpDb);
ctx.serverState = { started: null, authUser: null, needsOtp: false, needsTotp: false };
ctx.rateLimiter = { execute: async (fn) => fn() };
ctx.api = null;
ctx.friendState = null;
ctx.wsManager = null;
ctx.pluginLoader = null;
ctx.eventPipeline = null;

registerDashboardServices(loader, ctx);

// ── 造数据：一个 tracked 非好友 + 两条 poll 变化事件 ──
const UID = 'usr_test-0000-0000-0000-000000000001';
ctx.storage.run(
  `INSERT OR REPLACE INTO tracked_non_friends (user_id, display_name, avatar_image_url, added_at, last_refresh_at)
   VALUES ($u, $d, '', datetime('now'), datetime('now'))`,
  { $u: UID, $d: '测试用户' });
ctx.storage.insertEvent({
  type: 'friend-update', userId: UID, displayName: '测试用户',
  contentJson: { userId: UID, displayName: '测试用户', type: 'bio', bio: '新简介', previousBio: '旧简介' },
  worldId: '', worldName: '', createdAt: new Date().toISOString(), source: 'poll',
});
ctx.storage.insertEvent({
  type: 'friend-update', userId: UID, displayName: '测试用户',
  contentJson: { userId: UID, displayName: '测试用户', type: 'status', status: 'active', previousStatus: 'busy' },
  worldId: '', worldName: '', createdAt: new Date().toISOString(), source: 'poll',
});

test('dashboard.* 服务全部注册且 owner=core', () => {
  const names = [...services.keys()].filter((n) => n.startsWith('dashboard.'));
  assert.ok(names.length >= 19, `应有 >=19 个 dashboard.* 服务，实际 ${names.length}`);
  for (const n of names) assert.equal(serviceOwners.get(n), 'core');
});

test('dashboard.trackedNonFriends 返回 tracked 列表形状', () => {
  const r = services.get('dashboard.trackedNonFriends')({ limit: 10 });
  assert.ok(Array.isArray(r.tracked));
  assert.ok(r.tracked.some((x) => x.userId === UID && x.displayName === '测试用户'));
});

test('trackedNonFriends.lastChangeAt 与 trackedChanges 最新变化一致（真实变更时间，非检测时间）', () => {
  const list = services.get('dashboard.trackedNonFriends')({ limit: 10 }).tracked;
  const x = list.find((i) => i.userId === UID);
  assert.ok(x, '应能找到测试用户');
  const cs = services.get('dashboard.trackedChanges')({ userId: UID, limit: 5 }).changes;
  assert.ok(cs.length >= 2, '应有变化记录');
  // lastChangeAt 应等于变化时间线最新一条 createdAt（ISO 带 Z）
  assert.equal(x.lastChangeAt, cs[0].createdAt);
  // lastRefreshAt 是检测时间(SQLite 无时区 UTC 串),与 lastChangeAt 语义不同
  assert.ok(x.lastRefreshAt && x.lastRefreshAt !== x.lastChangeAt);
});

test('dashboard.trackedChanges 返回 bio/status 变化（含前后值）', () => {
  const r = services.get('dashboard.trackedChanges')({ userId: UID, limit: 10 });
  assert.ok(Array.isArray(r.changes));
  const types = r.changes.map((c) => c.type);
  assert.ok(types.includes('bio'));
  assert.ok(types.includes('status'));
  const bio = r.changes.find((c) => c.type === 'bio');
  assert.equal(bio.previousBio, '旧简介');
  assert.equal(bio.bio, '新简介');
  const status = r.changes.find((c) => c.type === 'status');
  assert.equal(status.previousStatus, 'busy');
  assert.equal(status.status, 'active');
});

test('dashboard.trackedChanges 返回 avatar 变化形状（前后缩略图字段）', () => {
  ctx.storage.insertEvent({
    type: 'friend-update', userId: UID, displayName: '测试用户',
    contentJson: { userId: UID, displayName: '测试用户', type: 'avatar', avatarImageUrl: 'https://api.vrchat.cloud/api/1/image/file_a/1/256', previousAvatarImageUrl: 'https://api.vrchat.cloud/api/1/image/file_b/1/256' },
    worldId: '', worldName: '', createdAt: new Date().toISOString(), source: 'poll',
  });
  const r = services.get('dashboard.trackedChanges')({ userId: UID, limit: 20 });
  const av = r.changes.find((c) => c.type === 'avatar');
  assert.ok(av);
  // #122 抽出 img-util 后 avatarThumb 经 imgProxy 改写为 /api/dashboard/image-proxy?url=...，
  // url 参数内的 /image/ 被百分比编码(%2Fimage%2F)，字面量 includes('/image/') 不再成立；
  // 正确断言：已是代理 URL 且解码后含 /image/（证明确实缩略图化）
  assert.ok(av.avatarImageUrl.startsWith('/api/dashboard/image-proxy?url='), '头像应走本地图片代理');
  assert.ok(decodeURIComponent(av.avatarImageUrl).includes('/image/'), '头像应缩略图化');
  assert.ok(av.previousAvatarImageUrl);
});

test('dashboard.trackedChanges 对非法 userId 返回空', () => {
  const r = services.get('dashboard.trackedChanges')({ userId: 'bad', limit: 10 });
  assert.deepEqual(r, { changes: [] });
});

test('dashboard.stats 返回聚合形状', () => {
  const r = services.get('dashboard.stats')({ days: 7 });
  assert.ok('onlineNow' in r);
  assert.ok(Number.isInteger(r.totalEvents));
  assert.ok(Array.isArray(r.byType));
  assert.ok(Array.isArray(r.byDay));
  assert.ok(Array.isArray(r.byHour));
});

test('dashboard.activityHeatmap 返回 24 格热图 + rangeDays（重复键 bug 回归）', () => {
  const r = services.get('dashboard.activityHeatmap')({ days: 7 });
  assert.equal(r.rangeDays, 7);
  assert.ok(Array.isArray(r.days));
  assert.equal(r.days.length, 7);
  assert.ok(r.days.every((row) => row.date && Array.isArray(row.hours) && row.hours.length === 24));
});

test('dashboard.recentWorlds 返回游玩分钟（会话切分口径）', () => {
  const W = 'wrld_test-0000-0000-0000-000000000001';
  const t0 = Date.now();
  const ev = (worldId, loc, dt) => ctx.storage.insertEvent({
    type: 'user-location', userId: 'usr_me', displayName: '我',
    contentJson: { location: loc }, worldId: worldId || '', worldName: worldId ? '测试世界' : '',
    createdAt: new Date(t0 + dt).toISOString(), source: 'ws',
  });
  // 会话 1：世界 A 10 分钟 → 离线
  ev(W, W + ':1', 0);
  ev(W, W + ':1', 10 * 60000);
  ev('', 'offline', 10 * 60000 + 1000);
  // 会话 2：世界 A 5 分钟（同世界后续停留）
  ev(W, W + ':2', 20 * 60000);
  ev(W, W + ':2', 25 * 60000);
  ev('', 'offline', 25 * 60000 + 1000);
  const r = services.get('dashboard.recentWorlds')({ limit: 10 });
  const w = r.find((x) => x.worldId === W);
  assert.ok(w, '世界应出现在足迹列表');
  assert.ok(w.minutes >= 15, `会话切分游玩分钟应 >=15，实际 ${w.minutes}`);
});

test('dashboard.gameSessions 会话切分（同世界延续/离线关段/跨世界切分）', () => {
  const W1 = 'wrld_test-0000-0000-0000-000000000002';
  const W2 = 'wrld_test-0000-0000-0000-000000000003';
  const t0 = Date.now();
  const ev = (worldId, loc, dt) => ctx.storage.insertEvent({
    type: 'user-location', userId: 'usr_me2', displayName: '我',
    contentJson: { location: loc }, worldId: worldId || '', worldName: worldId ? '世界' : '',
    createdAt: new Date(t0 + dt).toISOString(), source: 'ws',
  });
  // 世界1：10 分钟 → 同世界延续 5 分钟（不切分）→ 离线
  ev(W1, W1 + ':1', 0);
  ev(W1, W1 + ':1', 5 * 60000);
  ev(W1, W1 + ':1', 10 * 60000);
  ev('', 'offline', 10 * 60000 + 1000);
  // 世界2：切分新会话 3 分钟
  ev(W2, W2 + ':1', 20 * 60000);
  ev(W2, W2 + ':1', 23 * 60000);
  ev('', 'offline', 23 * 60000 + 1000);
  const r = services.get('dashboard.gameSessions')({ days: 7 });
  // 按本测试的世界过滤（DB 里可能有其他测试/数据的 user-location 事件；
  // 各测试用 now+偏移 造数据，绝对时间可能交错产生短会话碎片，故断言核心语义而非精确计数）
  const mySessions = r.sessions.filter((s) => s.worldId === W1 || s.worldId === W2);
  const myTotal = mySessions.reduce((a, s) => a + (s.durationMinutes || 0), 0);
  assert.ok(myTotal >= 13, `本测试世界总分钟应 >=13（W1 跨度 10 + W2 跨度 3），实际 ${myTotal}`);
  const w1s = mySessions.filter((s) => s.worldId === W1);
  const w2s = mySessions.filter((s) => s.worldId === W2);
  assert.ok(w1s.length >= 1 && Math.max(...w1s.map((s) => s.durationMinutes)) >= 10,
    `世界1应有 >=10 分钟会话（首尾跨度，同世界延续不切分），实际 ${JSON.stringify(w1s)}`);
  assert.ok(w2s.length >= 1 && Math.max(...w2s.map((s) => s.durationMinutes)) >= 3,
    `世界2应有 >=3 分钟会话，实际 ${JSON.stringify(w2s)}`);
});

test('dashboard.worldHistory 跨世界间隔不计入 + 末段封口', () => {
  const W = 'wrld_test-0000-0000-0000-000000000004';
  const B = 'wrld_test-0000-0000-0000-000000000005';
  // 过去基准（now-6 天）：worldHistory 无日期窗口，其他测试的事件都在 now+ 偏移（now..now+50min），
  // 用过去基准避免时间交错导致会话碎片
  const t0 = Date.now() - 6 * 86400000;
  const ev = (worldId, loc, dt) => ctx.storage.insertEvent({
    type: 'user-location', userId: 'usr_me3', displayName: '我',
    contentJson: { location: loc }, worldId: worldId || '', worldName: worldId ? '世界' : '',
    createdAt: new Date(t0 + dt).toISOString(), source: 'ws',
  });
  // W 段 1（10 分钟）→ 离线 → B 段（10 分钟，不应计入 W）→ 离线 → W 段 2（10 分钟）→ 离线
  ev(W, W + ':1', 0); ev(W, W + ':1', 10 * 60000); ev('', 'offline', 10 * 60000 + 1000);
  ev(B, B + ':1', 20 * 60000); ev(B, B + ':1', 30 * 60000); ev('', 'offline', 30 * 60000 + 1000);
  ev(W, W + ':2', 40 * 60000); ev(W, W + ':2', 50 * 60000); ev('', 'offline', 50 * 60000 + 1000);
  const r = services.get('dashboard.worldHistory')({ worldId: W });
  assert.equal(r.visits, 2, `W 应 2 次进入，实际 ${r.visits}`);
  assert.equal(r.minutes, 20, `W 分钟应 20（10+10，B 段不计入），实际 ${r.minutes}`);
  const rb = services.get('dashboard.worldHistory')({ worldId: B });
  assert.equal(rb.minutes, 10, 'B 段应计 10 分钟');
});

test('dashboard.trackedAdd 幂等 + 拒绝自己 + trackedRemove 标记', () => {
  const TID = 'usr_test-0000-0000-0000-0000000000a1';
  const selfId = services.get('dashboard.trackedNonFriends') ? null : null;
  const r1 = services.get('dashboard.trackedAdd')({ userId: TID, displayName: '测试追踪' });
  assert.equal(r1.ok, true);
  assert.equal(r1.added, true, '首次添加 added=true');
  const r2 = services.get('dashboard.trackedAdd')({ userId: TID, displayName: '测试追踪' });
  assert.equal(r2.added, false, '重复添加幂等 added=false');
  // 拒绝自己（事件表里有 user-location 的自己）
  const selfEv = ctx.storage.query(`SELECT user_id FROM events WHERE type='user-location' AND user_id LIKE 'usr_%' LIMIT 1`);
  if (selfEv.length) {
    assert.throws(() => services.get('dashboard.trackedAdd')({ userId: selfEv[0].user_id }), /不能追踪自己/);
  }
  // 移除（标记 removed_at）后列表不再显示
  const rm = services.get('dashboard.trackedRemove')({ userId: TID });
  assert.equal(rm.removed, true);
  const list = services.get('dashboard.trackedNonFriends')({ limit: 500 });
  assert.ok(!list.tracked.some((x) => x.userId === TID), '移除后不在列表');
});

test('dashboard.groupAnnouncementsAll 汇总跨群组公告', () => {
  const ev = (gid, gname, title, msg, dt) => ctx.storage.insertEvent({
    type: 'notification-v2', userId: 'usr_ann', displayName: '公告',
    contentJson: { id: 'not_' + gid, type: 'group.announcement', title: gname + ': ' + title, message: msg,
      data: { groupId: gid, groupName: gname, announcementTitle: title } },
    worldId: '', worldName: '', createdAt: new Date(Date.now() - dt).toISOString(), source: 'ws',
  });
  ev('grp_ann1', '群组A', '公告一', '内容一', 300000);
  ev('grp_ann2', '群组B', '公告二', '内容二', 600000);
  const r = services.get('dashboard.groupAnnouncementsAll')({ limit: 50 });
  assert.ok(r.total >= 2, '至少汇总 2 条公告');
  const a1 = r.announcements.find((a) => a.groupId === 'grp_ann1');
  assert.ok(a1, '群组A 公告在汇总中');
  assert.equal(a1.title, '公告一');
  assert.equal(a1.groupName, '群组A');
  assert.equal(a1.text, '内容一');
  // 降序（最新在前）
  const ts = r.announcements.map((a) => a.createdAt);
  const sorted = [...ts].sort().reverse();
  assert.deepEqual(ts, sorted, '公告按时间降序');
});

test('avatarFileId 从代理/原始 URL 提取 file id（#122 imgProxy 回归）', () => {
  const raw = 'https://api.vrchat.cloud/api/1/file/file_de43c23b-8efa-4f4c-acb0-8c0c2dad9817/1/file';
  const proxied = '/api/dashboard/image-proxy?url=' + encodeURIComponent(raw);
  // 代理 URL 里的 /file/ 被编码成 %2Ffile%2F，直接正则失配；avatarFileId 先还原再匹配
  assert.equal(avatarFileId(proxied), 'file_de43c23b-8efa-4f4c-acb0-8c0c2dad9817');
  assert.equal(avatarFileId(raw), 'file_de43c23b-8efa-4f4c-acb0-8c0c2dad9817');
  assert.equal(avatarFileId(''), null);
  assert.equal(avatarFileId(null), null);
  assert.equal(avatarFileId('https://example.com/no-file-here'), null);
});
// ── avatar 缩略图推导：WS 推送的 avatar 事件有时只带 avatarImageUrl（原图）不带
// avatarThumbnailUrl（缩略图）→ 后端应从 avatarImageUrl 推导缩略图（/file → /image/1/256），
// 否则前端只显示模型名不显示模型图（用户反馈）
test('dashboard.events avatar 事件缺缩略图时从 avatarImageUrl 推导', async () => {
  const AUID = 'usr_test-0000-0000-0000-0000000000b1';
  const fid = 'file_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const avatarUrl = 'https://api.vrchat.cloud/api/1/file/' + fid + '/1/file';
  ctx.storage.insertEvent({
    type: 'friend-update', userId: AUID, displayName: '缩略图用户',
    contentJson: {
      userId: AUID, displayName: '缩略图用户', type: 'avatar',
      avatarName: '测试模型',
      avatarImageUrl: avatarUrl,
      previousAvatarImageUrl: 'https://api.vrchat.cloud/api/1/file/file_bbbbbbbb-0000-0000-0000-000000000000/1/file',
    },
    worldId: '', worldName: '', createdAt: new Date().toISOString(), source: 'ws',
  });
  const r = await services.get('dashboard.events')({ limit: 50, offset: 0 });
  const ev = r.events.find((e) => e.userId === AUID);
  assert.ok(ev, '应能查到 avatar 事件');
  assert.equal(ev.updateType, 'avatar');
  assert.equal(ev.avatarName, '测试模型', '模型名应保留');
  assert.ok(ev.avatarThumbnailUrl, 'avatarThumbnailUrl 不应为空');
  // 缩略图经 imgProxy 代理（URL 被编码），decodeURIComponent 还原后应是推导的 image/{fid}/1/256
  const decodedThumb = decodeURIComponent(ev.avatarThumbnailUrl);
  assert.ok(
    decodedThumb.includes('/image/') && decodedThumb.includes('/1/256'),
    '缩略图应为推导的 image/{fid}/1/256，实际: ' + ev.avatarThumbnailUrl
  );
  assert.ok(decodedThumb.includes(fid), '缩略图应含同一 file id，实际: ' + ev.avatarThumbnailUrl);
});

// 审核建议补充：WS 推送**带** avatarThumbnailUrl 时，返回的也必须是 imgProxy 代理形式
// （否则正常事件直连 CDN 裸 URL，国内加载失败/变慢，恰好复现"图不显示"）
test('dashboard.events avatar 事件带缩略图时仍走 imgProxy 代理', async () => {
  const PUID = 'usr_test-0000-0000-0000-0000000000c1';
  const rawThumb = 'https://api.vrchat.cloud/api/1/image/file_cccccccc-0000-0000-0000-000000000000/1/256';
  ctx.storage.insertEvent({
    type: 'friend-update', userId: PUID, displayName: '代理用户',
    contentJson: {
      userId: PUID, displayName: '代理用户', type: 'avatar',
      avatarName: '带图模型',
      avatarImageUrl: 'https://api.vrchat.cloud/api/1/file/file_cccccccc-0000-0000-0000-000000000000/1/file',
      avatarThumbnailUrl: rawThumb,
    },
    worldId: '', worldName: '', createdAt: new Date().toISOString(), source: 'ws',
  });
  const r = await services.get('dashboard.events')({ limit: 50, offset: 0 });
  const ev = r.events.find((e) => e.userId === PUID);
  assert.ok(ev, '应能查到 avatar 事件');
  // 必须带 imgProxy 前缀（走本地图片代理），不允许裸 CDN URL
  assert.ok(
    ev.avatarThumbnailUrl.startsWith('/api/dashboard/image-proxy?url='),
    '带缩略图事件也应走 imgProxy 代理，实际: ' + ev.avatarThumbnailUrl
  );
  // 解码后仍是原缩略图
  const decoded = decodeURIComponent(ev.avatarThumbnailUrl.split('?url=')[1]);
  assert.equal(decoded, rawThumb, '解码后应为原始缩略图 URL');
});

// ── issue #127 Bug2：upsertFriend 空串不覆盖已有 display_name ──
// offline/空 payload 事件会以 '' 覆盖已存名字，导致离线好友显示 '?'
test('upsertFriend 空串不覆盖已有 display_name', () => {
  const FID = 'usr_test-0000-0000-0000-0000000000e1';
  ctx.storage.upsertFriend({ userId: FID, displayName: '真实名字', isOnline: 1 });
  // 再 upsert 一个空 displayName 的事件（模拟 offline/缺名 payload）→ 不应清空名字
  ctx.storage.upsertFriend({ userId: FID, displayName: '', isOnline: 0 });
  const row = ctx.storage.query(`SELECT display_name AS dn FROM friends WHERE user_id=$u`, { $u: FID })[0];
  assert.equal(row.dn, '真实名字', '空 displayName 不应覆盖已有名字，实际: ' + row.dn);
  // 非空名字正常更新
  ctx.storage.upsertFriend({ userId: FID, displayName: '新名字', isOnline: 1 });
  const row2 = ctx.storage.query(`SELECT display_name AS dn FROM friends WHERE user_id=$u`, { $u: FID })[0];
  assert.equal(row2.dn, '新名字', '非空 displayName 应正常更新');
});

// ── 清理 ──
after(() => {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
});
