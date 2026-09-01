// PR#56 好友资料变更追踪 — 端到端逻辑实测（使用 PR head b3502fb 的真实代码）
import { Storage } from 'file:///D:/workspace/vrcx-mcp-actions/tmp/wt56/core/storage.js';
import { EventPipeline } from 'file:///D:/workspace/vrcx-mcp-actions/tmp/wt56/core/event-pipeline.js';
import { rmSync } from 'node:fs';

const DB = 'tmp/test-pr56.sqlite3';
rmSync(DB, { force: true });
rmSync(DB + '-wal', { force: true });
rmSync(DB + '-shm', { force: true });

const storage = new Storage();
await storage.init(DB);
const pipeline = new EventPipeline(storage, null);

let failed = 0;
const T = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name); if (!cond) failed++; };

const mkUpdate = (user, i) => ({
  type: 'friend-update',
  userId: user.id,
  displayName: user.displayName,
  content: { user },
  receivedAt: new Date(2026, 7, 19, 0, i).toISOString(),
});
const mkLocation = (i) => ({
  type: 'friend-location',
  userId: 'usr_a',
  displayName: 'Alice',
  location: 'wrld_abc:12345',
  worldId: 'wrld_abc',
  platform: 'standalonewindows',
  receivedAt: new Date(2026, 7, 19, 0, i).toISOString(),
});
const getTypes = () => storage.getFriendProfileChanges('usr_a', {})
  .map(r => JSON.parse(r.content_json).type).sort();

// T1: 首次采集（无基线）不应误报变更
const userA = { id: 'usr_a', displayName: 'Alice', bio: 'bio A', currentAvatarImageUrl: 'img/a.png',
  currentAvatarThumbnailImageUrl: 'img/a_thumb.png', status: 'active', statusDescription: 'hello',
  userIcon: 'icon/a.png', pronouns: 'she/her' };
await pipeline.process(mkUpdate(userA, 1));
T('T1 首次采集不误报变更', storage.getFriendProfileChangeCount('usr_a', {}) === 0);
const f1 = storage.getFriend('usr_a');
T('T1 friends 行写入 bio/icon/pronouns/avatar', !!(f1 && f1.bio === 'bio A' && f1.user_icon === 'icon/a.png'
  && f1.pronouns === 'she/her' && f1.avatar_image_url === 'img/a.png'));

// T2: 纯变更检测（无其他事件穿插）：bio + avatar 变化 → 2 条
const userB = { ...userA, bio: 'bio B', currentAvatarImageUrl: 'img/b.png', currentAvatarThumbnailImageUrl: 'img/b_thumb.png' };
await pipeline.process(mkUpdate(userB, 2));
const n2 = storage.getFriendProfileChangeCount('usr_a', {});
console.log('  [T2] 变更计数 =', n2, 'types =', JSON.stringify(getTypes()));
T('T2 avatar+bio 变更各记录 1 条', n2 === 2 && JSON.stringify(getTypes()) === JSON.stringify(['avatar', 'bio']));
const avRow = storage.getFriendProfileChanges('usr_a', { types: 'avatar' })[0];
const avPayload = JSON.parse(avRow.content_json);
T('T2 avatar 事件含新旧值', avPayload.avatarImageUrl === 'img/b.png' && avPayload.previousAvatarImageUrl === 'img/a.png');
T('T2 avatar 事件 source=websocket / 顶层 type=friend-update', avRow.source === 'websocket' && avRow.type === 'friend-update');

// T3: 无变化 update → 不再产生事件
await pipeline.process(mkUpdate(userB, 3));
T('T3 无变化不重复记录', storage.getFriendProfileChangeCount('usr_a', {}) === 2);

// T4: ★核心复现★ 生产事件流穿插 friend-location（不带 user 对象）→ 检查基线是否被清空 → 再变更是否漏记
await pipeline.process(mkLocation(4));
const f4 = storage.getFriend('usr_a');
console.log('  [T4] location 事件后 friends 行: bio=', JSON.stringify(f4.bio),
  'avatar=', JSON.stringify(f4.avatar_image_url),
  'user_icon=', JSON.stringify(f4.user_icon), 'pronouns=', JSON.stringify(f4.pronouns),
  'status=', JSON.stringify(f4.status), 'status_description=', JSON.stringify(f4.status_description));
const userC = { ...userB, bio: 'bio C', currentAvatarImageUrl: 'img/c.png' };
await pipeline.process(mkUpdate(userC, 5));
const n5 = storage.getFriendProfileChangeCount('usr_a', {});
console.log('  [T4] 穿插 location 后再次变更，事件计数 =', n5, 'types =', JSON.stringify(getTypes()));
T('T4 穿插 location 后变更仍被记录（期望 4 条: avatar+bio 各 2 次）', n5 === 4);

// T5: types 过滤与非法 types 兜底
const onlyBio = storage.getFriendProfileChanges('usr_a', { types: 'bio' });
T('T5 types=bio 过滤', onlyBio.length > 0 && onlyBio.every(r => JSON.parse(r.content_json).type === 'bio'));
const bogus = storage.getFriendProfileChanges('usr_a', { types: 'bogus' });
T('T5 非法 types 兜底为全部', bogus.length === n5);

// T6: limit/offset 分页（动态基于当前计数）
const total = storage.getFriendProfileChangeCount('usr_a', {});
const page1 = storage.getFriendProfileChanges('usr_a', { limit: 2, offset: 0 });
const page2 = storage.getFriendProfileChanges('usr_a', { limit: 2, offset: 2 });
const ids = new Set([...page1.map(r => r.id), ...page2.map(r => r.id)]);
T('T6 limit/offset 分页互不重叠且有序', page1.length === Math.min(2, total) && page2.length === Math.max(0, total - 2)
  && page1.length + page2.length === total && ids.size === total
  && (page2.length === 0 || page1[0].created_at >= page2[0].created_at));

// T7: 旧库迁移（无 bio 列）→ ALTER 补列
import Database from 'better-sqlite3';
const OLD_DB = 'tmp/test-pr56-old.sqlite3';
rmSync(OLD_DB, { force: true });
const odb = new Database(OLD_DB);
odb.exec(`CREATE TABLE friends (user_id TEXT PRIMARY KEY, display_name TEXT, memo TEXT, trust_level TEXT,
  is_online INTEGER DEFAULT 0, location TEXT, world_id TEXT, world_name TEXT, platform TEXT,
  status TEXT, status_description TEXT, avatar_image_url TEXT, last_seen TEXT, last_online TEXT, last_offline TEXT,
  created_at TEXT, updated_at TEXT)`);
odb.close();
const storage2 = new Storage();
await storage2.init(OLD_DB);
const cols2 = storage2.db.prepare('PRAGMA table_info(friends)').all().map(c => c.name);
T('T7 旧库迁移补 bio/user_icon/pronouns 列', ['bio', 'user_icon', 'pronouns'].every(c => cols2.includes(c)));
storage2.db.close();

// T8: status 变更检测（status 文本 + statusDescription）
const userD = { ...userB, status: 'join me', statusDescription: 'new desc' };
await pipeline.process(mkUpdate(userD, 6));
const st = storage.getFriendProfileChanges('usr_a', { types: 'status' });
T('T8 status 变更记录', st.length === 1 && JSON.parse(st[0].content_json).previousStatus === 'active');

console.log('\n===== 结果: ' + (failed === 0 ? '全部 PASS' : failed + ' 项 FAIL') + ' =====');
process.exit(failed === 0 ? 0 : 1);
