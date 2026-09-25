/**
 * test/event-pipeline-avatar-iconurl.test.mjs — 上游移除 currentAvatar* 后「换模型」仍能产出【带图】avatar 事件（#251）
 *
 * 背景：#251 的核心修复——新版资料系统里 `bannerType === 'avatarBanner'` 时 `iconUrl` 指向的就是模型图；
 *   上游 main 的模型图来源读的是已被移除的 `currentAvatarImageUrl` ⇒ 拿不到值 ⇒
 *   换模型时**行照样产出、但图是空的**（审查方实测：上游 1609/1609 空图行）。
 *
 * 本用例驱动【真实】EventPipeline + 临时 SQLite，钉住该修复的行为：
 *   基线模型图非空（OLD）+ 载荷 `bannerType=avatarBanner`、`iconUrl=NEW`（**载荷里没有 currentAvatarImageUrl**）
 *   ⇒ **恰好 1 条 avatar 事件，且 `avatarImageUrl === NEW`**（来自 iconUrl）。
 * 变异自检：把模型图来源退回旧字段（只读 currentAvatarImageUrl）⇒ 事件图变空 ⇒ 本用例变红。
 * 注：该次推送在本分支还会多产一条 `user_icon`（上游自身 `iconUrl || userIcon` 回落所致），
 *   那是 #263（`!isAvatarBanner` 门禁）负责消掉的残留，故此处不断言它，避免与 #263 耦合。
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

const UID = 'usr_iconurl-0000-0000-000000000001';
const ICON_OLD = 'https://api.vrchat.cloud/api/1/file/file_aaaa1111-0000-0000-0000-000000000001/1/file';
const ICON_NEW = 'https://api.vrchat.cloud/api/1/file/file_bbbb2222-0000-0000-0000-000000000002/1/file';
const tmpDb = path.join(__dirname, 'test-avatar-iconurl.sqlite3');
const logRoot = path.join(__dirname, 'avatar-iconurl-rundir');

for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
rmSync(logRoot, { recursive: true, force: true });

const storage = new Storage();
await storage.init(tmpDb);
// 基线：模型图非空（diff 的触发条件；空基线时 avatarChanged 恒假，不会产事件）
storage.upsertFriend({ userId: UID, displayName: '模型图测试', userIcon: ICON_OLD, avatarImageUrl: ICON_OLD, bio: '', status: 'active' });
const pipeline = new EventPipeline(storage, { get: () => null });
initLogger({ dir: logRoot, format: 'text', level: 'silent' });

after(() => {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
  rmSync(logRoot, { recursive: true, force: true });
});

test('bannerType=avatarBanner：换模型产出的 avatar 事件带【iconUrl 派生的模型图】（不再是空图）', async () => {
  await pipeline.process({
    type: 'friend-update',
    userId: UID,
    displayName: '模型图测试',
    receivedAt: '2026-09-25T21:00:00.000Z',
    // ⚠️ 载荷里【没有】currentAvatarImageUrl / currentAvatarThumbnailImageUrl —— 与上游新版资料系统一致
    content: { user: { bannerType: 'avatarBanner', iconUrl: ICON_NEW, userIcon: ICON_OLD, bio: '', status: 'active' } },
  });
  const rows = storage.getFriendProfileChanges(UID, { types: 'avatar' });
  assert.equal(rows.length, 1, `应恰好 1 条 avatar 变更，实际 ${rows.length}`);
  const c = JSON.parse(rows[0].content_json);
  assert.equal(c.avatarImageUrl, ICON_NEW, '模型图 URL 必须来自 iconUrl（上游移除 currentAvatarImageUrl 后的唯一来源）');
  assert.ok(c.avatarImageUrl, '不得是空图行（上游 main 的缺陷正是行存在但图为空）');
  assert.equal(c.previousAvatarImageUrl, ICON_OLD, '旧图 URL 应落库');
});
