/**
 * test/event-pipeline-avatar-icon-banner.test.mjs — bannerType=avatarBanner 档不产出「更新了头像图标」（#263）
 *
 * 背景：新版资料系统里 bannerType === 'avatarBanner' 时 iconUrl 指向的【就是当前模型图】——
 *   若此处仍判 user_icon，换一次模型会同时产出「更换模型」+「更新了头像图标」，且后者前后常是同一张图
 *   （用户实测截图里出现过「更新了头像图标 🍮 → 🍮」）。
 *
 * 本用例钉住的不变量（在 #263 单独分支上亦成立）：该形态下【不产出 user_icon 事件】。
 *   注：该形态下的「更换模型」事件由 #251（avatarImageUrlFromUser）提供；本分支未含 #251 时为 0 条，
 *   合入 #251 后同一次推送应恰好 1 条 avatar —— 故此处只断言本 PR 负责的那一半（无 user_icon）。
 * 第二条用例是「防误伤」对照：非 avatarBanner（真·用户图标）必须照常产出 user_icon，门禁不得过宽。
 * 自包含：临时 SQLite + stub，不依赖网络/凭据。
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

const UID = 'usr_bannericon-0000-0000-000000000001';
const ICON_OLD = 'https://assets.vrchat.example/icons/old.png';
const ICON_NEW = 'https://assets.vrchat.example/icons/new.png';
const tmpDb = path.join(__dirname, 'test-avatar-icon-banner.sqlite3');
const logRoot = path.join(__dirname, 'avatar-icon-banner-rundir');

for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
rmSync(logRoot, { recursive: true, force: true });

const storage = new Storage();
await storage.init(tmpDb);
storage.upsertFriend({ userId: UID, displayName: '图标门禁测试', userIcon: ICON_OLD, bio: '', status: 'active' });
const pipeline = new EventPipeline(storage, { get: () => null });
initLogger({ dir: logRoot, format: 'text', level: 'silent' });

after(() => {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
  rmSync(logRoot, { recursive: true, force: true });
});

function makeUpdate({ bannerType, iconUrl }) {
  return {
    type: 'friend-update',
    userId: UID,
    displayName: '图标门禁测试',
    receivedAt: '2026-09-25T20:00:00.000Z',
    content: { user: { bannerType, iconUrl, bio: '', status: 'active' } },
  };
}

const iconEvents = () => storage.getFriendProfileChanges(UID, { types: 'user_icon' });
const resetEvents = () => storage.run("DELETE FROM events WHERE user_id = $u", { $u: UID });


test('bannerType=avatarBanner：iconUrl 变化不产出 user_icon 事件（该字段此时即模型图）', async () => {
  resetEvents();
  await pipeline.process(makeUpdate({ bannerType: 'avatarBanner', iconUrl: ICON_NEW }));
  assert.equal(iconEvents().length, 0, 'avatarBanner 档不得产出「更新了头像图标」（换模型会重复）');
});

test('防误伤：非 avatarBanner（真·用户图标）仍照常产出 user_icon 事件', async () => {
  resetEvents();
  storage.upsertFriend({ userId: UID, displayName: '图标门禁测试', userIcon: ICON_OLD });
  await pipeline.process(makeUpdate({ bannerType: 'color', iconUrl: ICON_NEW }));
  assert.equal(iconEvents().length, 1, '非 avatarBanner 档应恰好 1 条 user_icon（门禁不得过宽）');
});
