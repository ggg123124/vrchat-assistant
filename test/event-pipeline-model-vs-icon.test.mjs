/**
 * test/event-pipeline-model-vs-icon.test.mjs —— 换模型 vs 只换头像 的事件分类（用户 2026-09-26 定案）
 *
 * 定案原话：「换模型就显示换模型啊。只有只换头像才显示换头像」✓
 * 背景（生产实证，id 17146/17147 同一秒）：换模型时本层同时产出 avatar 与 user_icon 两条事件，
 *   且 user_icon 携带的 `userIcon` 与 avatar 的 `avatarImageUrl`【是同一个文件】⇒ 动态流显示成
 *   「更新了头像图标」✗。#263 的 `!isAvatarBanner` 门禁只覆盖 avatarBanner 档，罩不住这种。
 * 修法：按【文件同一性】判定 —— 本次 iconUrl 与任一模型图字段同文件 ⇒ 它是模型图，不是用户图标。
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

const MODEL = 'https://api.vrchat.cloud/api/1/image/file_11111111-0000-0000-0000-000000000001/1/256';
const ICON_ONLY = 'https://api.vrchat.cloud/api/1/image/file_22222222-0000-0000-0000-000000000002/1/256';
const OLD_ICON = 'https://api.vrchat.cloud/api/1/image/file_33333333-0000-0000-0000-000000000003/1/256';
const tmpDb = path.join(__dirname, 'test-model-vs-icon.sqlite3');
const logRoot = path.join(__dirname, 'model-vs-icon-rundir');
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

const UID = 'usr_mvsi-0000-0000-0000-000000000001';
const clear = () => storage.run('DELETE FROM events WHERE user_id = $u', { $u: UID });
const types = () => ({
  avatar: storage.getFriendProfileChanges(UID, { types: 'avatar' }).length,
  icon: storage.getFriendProfileChanges(UID, { types: 'user_icon' }).length,
});

test('换模型（bannerType 非 avatarBanner、iconUrl 与模型图同文件）⇒ 记「模型变动」，不得记「更新了头像图标」', async () => {
  clear();
  storage.upsertFriend({ userId: UID, displayName: '分类测试', userIcon: OLD_ICON, avatarImageUrl: '', bio: '', status: 'active' });
  await pipeline.process({
    type: 'friend-update', userId: UID, displayName: '分类测试', receivedAt: '2026-09-26T04:00:00.000Z',
    content: { user: { bannerType: 'color', iconUrl: MODEL, currentAvatarImageUrl: MODEL, userIcon: ICON_ONLY, bio: '', status: 'active' } },
  });
  const n = types();
  assert.equal(n.icon, 0, '换模型不得产出 user_icon（否则动态流显示成「更新了头像图标」）');
  assert.equal(n.avatar, 1, '换模型必须产出 1 条 avatar 事件（标签「模型变动」）');
});

test('只换头像（iconUrl 与任何模型图字段都不同文件）⇒ 记「更新了头像图标」', async () => {
  clear();
  storage.upsertFriend({ userId: UID, displayName: '分类测试', userIcon: OLD_ICON, avatarImageUrl: '', bio: '', status: 'active' });
  await pipeline.process({
    type: 'friend-update', userId: UID, displayName: '分类测试', receivedAt: '2026-09-26T04:05:00.000Z',
    content: { user: { bannerType: 'color', iconUrl: ICON_ONLY, bio: '', status: 'active' } },
  });
  const n = types();
  assert.equal(n.icon, 1, '真·只换头像时仍须产出 user_icon');
  assert.equal(n.avatar, 0, '没换模型时不得产出 avatar 事件');
});

test('幂等：同一文件反复推送（含 URL 形态不同）⇒ 仍只有 1 条 avatar 事件（审查 🔴 回归）', async () => {
  clear();
  storage.upsertFriend({ userId: UID, displayName: '分类测试', userIcon: OLD_ICON, avatarImageUrl: '', bio: '', status: 'active' });
  const MODEL_512 = MODEL.replace('/1/256', '/1/512');   // 同文件、不同 URL 形态
  for (const [i, url] of [MODEL, MODEL, MODEL_512, MODEL].entries()) {
    await pipeline.process({
      type: 'friend-update', userId: UID, displayName: '分类测试', receivedAt: '2026-09-26T04:10:0' + i + '.000Z',
      content: { user: { bannerType: 'color', iconUrl: url, currentAvatarImageUrl: url, bio: '', status: 'active' } },
    });
  }
  const n = types();
  assert.equal(n.avatar, 1, '同一文件的重复推送不得重复产出 avatar 事件（应按文件级去重）');
  assert.equal(n.icon, 0, '换模型不得产出 user_icon');
});
