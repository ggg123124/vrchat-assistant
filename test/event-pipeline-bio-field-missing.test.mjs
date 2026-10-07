/**
 * test/event-pipeline-bio-field-missing.test.mjs —— WS 载荷缺 bio 键时不得产假「简介变更」/不得清空基线
 *
 * 用户 2026-10-07 报障：「筛选简介……为什么全是已清空，这个功能好像坏了吧」。
 * 生产实测根因：新版资料系统把 bio 移出 user 对象 —— **WS 载荷与 GET /users/{id} 都没有 bio 键**
 * （GET /profile/{userId} 才有）。旧判据 `prev.bio && prev.bio !== ''` 在载荷缺键时恒真
 * ⇒ 每次资料推送都插一条「简介被清空」假事件（前端渲染「(已清空)」），并把 friends.bio 写空。
 * 修复：**缺字段＝未知** ⇒ 不 diff、不写该列（真值改由 friend-refresh 走 /profile 拉取后 diff）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const { EventPipeline } = await import(pathToFileURL(path.join(REPO, 'core', 'event-pipeline.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);
const { initLogger } = await import(pathToFileURL(path.join(REPO, 'core', 'logger.js')).href);

const tmpDb = path.join(__dirname, 'test-bio-field-missing.sqlite3');
const logRoot = path.join(__dirname, 'bio-field-missing-rundir');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
rmSync(logRoot, { recursive: true, force: true });

const storage = new Storage();
await storage.init(tmpDb);
const pipeline = new EventPipeline(storage, { get: () => null });
initLogger({ dir: logRoot, format: 'text', level: 'silent' });
after(() => {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
  rmSync(logRoot, { recursive: true, force: true });
});

const UID = 'usr_bio-0000-0000-0000-000000000001';
const ICON = 'https://api.vrchat.cloud/api/1/image/file_dddddddd-0000-0000-0000-000000000004/1/256';
const countBio = () => storage.query(
  "SELECT COUNT(*) n FROM events WHERE user_id = $u AND json_extract(content_json,'$.type') = 'bio'",
  { $u: UID })[0].n;
const bioNow = () => storage.getFriend(UID).bio;

// 生产实测的载荷形态：有 status / statusDescription / pronouns / iconUrl，**没有 bio 键**
const userWithoutBio = () => ({
  id: UID, displayName: '好友A', status: 'active', statusDescription: 'hi', pronouns: '',
  iconUrl: ICON, bannerType: 'customImage',
});
const ev = (user, at) => ({ type: 'friend-update', userId: UID, displayName: '好友A', receivedAt: at, content: { userId: UID, user } });

storage.upsertFriend({ userId: UID, displayName: '好友A', bio: '老简介', status: 'active' });

test('🔴 载荷无 bio 键 ⇒ 不得产「简介变更」事件、也不得清空已存简介（修复前：两样都中）', async () => {
  await pipeline.process(ev(userWithoutBio(), '2026-10-07T01:00:00.000Z'));
  assert.equal(countBio(), 0, '载荷缺 bio ⇒ 未知，不得当成"被清空"');
  assert.equal(bioNow(), '老简介', '载荷缺 bio ⇒ 不得把 friends.bio 写空');
});

test('载荷带 bio 且变化 ⇒ 正常产事件并回写（真值路径仍在）', async () => {
  await pipeline.process(ev({ ...userWithoutBio(), bio: '新简介' }, '2026-10-07T01:10:00.000Z'));
  assert.equal(countBio(), 1, '带 bio 字段的真实变化必须记录');
  assert.equal(bioNow(), '新简介');
  const row = storage.query("SELECT content_json AS c FROM events WHERE user_id = $u AND json_extract(content_json,'$.type')='bio' ORDER BY id DESC LIMIT 1", { $u: UID })[0];
  const c = JSON.parse(row.c);
  assert.equal(c.previousBio, '老简介');
  assert.equal(c.bio, '新简介');
});

test('载荷带空 bio（真·清空）⇒ 仍记录（显式清空是真实变更）', async () => {
  await pipeline.process(ev({ ...userWithoutBio(), bio: '' }, '2026-10-07T01:20:00.000Z'));
  assert.equal(countBio(), 2, '显式 bio:"" 属真实清空，应记录');
  assert.equal(bioNow(), '');
});
