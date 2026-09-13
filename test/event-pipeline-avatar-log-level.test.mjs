/**
 * test/event-pipeline-avatar-log-level.test.mjs — 头像变更日志降级回归（交付 A）
 *
 * 背景（生产实测）：头像变更是热路径（单好友 5 分钟窗口最多 26 条 ≈ 12 秒一条、2 天 683 条），
 * 逐条 INFO 占日志 34.5%，信噪比过低 → case 'avatar' 降为 debug（DB 事件流仍完整落库）。
 * 覆盖：avatar 变更不再走 info、仍走 debug；事件照旧落库（含新旧图 URL）；
 *       bio/status 变更不受误伤（仍走 info）；级别穿透（debug 落盘 / info 不落盘）。
 * 自包含：临时 SQLite + stub worldCache，不依赖网络/凭据。
 *
 * 说明：event-pipeline 的 logger 是 getLogger('event') 的闭包实例，无法替换导出 logger 方法拦截；
 * 按 world-kb-backfill.test.mjs:146-152 同款思路（临时替换收集行 + try/finally 还原），
 * 改在日志写盘出口 console.info/console.debug 处收集。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const { initLogger } = await import(pathToFileURL(path.join(REPO, 'core', 'logger.js')).href);
const { EventPipeline } = await import(pathToFileURL(path.join(REPO, 'core', 'event-pipeline.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);

const USER_ID = 'usr_avlogtest-0000-0000-000000000001';
const OLD_AVATAR = 'https://api.vrchat.example/avatars/avtr_old/image.png';
const NEW_AVATAR = 'https://api.vrchat.example/avatars/avtr_new/image.png';

const tmpDb = path.join(__dirname, 'test-avatar-log-level.sqlite3');
const logRoot = path.join(__dirname, 'avatar-log-level-rundir');

for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
rmSync(logRoot, { recursive: true, force: true });

const storage = new Storage();
await storage.init(tmpDb);
// 预置好友基线行：avatar/bio/status 有值才能触发 diff（与 _handleUpdate 判据一致）
storage.upsertFriend({
  userId: USER_ID,
  displayName: '头像日志测试好友',
  avatarImageUrl: OLD_AVATAR,
  bio: '旧简介',
  status: 'active',
  statusDescription: '旧状态',
  userIcon: 'https://assets.vrchat.example/icons/old.png',
  pronouns: 'they/them',
});

const pipeline = new EventPipeline(storage, { get: () => null });

after(() => {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
  rmSync(logRoot, { recursive: true, force: true });
});

function makeUpdate({ avatar, bio, status, statusDescription }) {
  return {
    type: 'friend-update',
    userId: USER_ID,
    displayName: '头像日志测试好友',
    receivedAt: '2026-09-13T09:00:00.000Z',
    content: {
      user: {
        currentAvatarImageUrl: avatar ?? NEW_AVATAR,
        currentAvatarName: '新模型',
        currentAvatarThumbnailImageUrl: 'https://api.vrchat.example/avatars/avtr_new/thumb.png',
        bio: bio ?? '旧简介',
        status: status ?? 'active',
        statusDescription: statusDescription ?? '旧状态',
        userIcon: 'https://assets.vrchat.example/icons/old.png',
        pronouns: 'they/them',
      },
    },
  };
}

// 临时替换 console.info/console.debug 收集日志行（照抄 world-kb-backfill 的 try/finally 还原模式）
async function captureConsole(fn) {
  const infoLines = [];
  const debugLines = [];
  const origInfo = console.info;
  const origDebug = console.debug;
  console.info = (m) => { infoLines.push(String(m)); };
  console.debug = (m) => { debugLines.push(String(m)); };
  try { await fn(); } finally { console.info = origInfo; console.debug = origDebug; }
  return { infoLines, debugLines };
}

test('avatar 变更：info 收不到、debug 收到，且事件照旧落库（含新旧图 URL）', async () => {
  initLogger({ dir: path.join(logRoot, 'av-debug'), format: 'text', level: 'debug' });
  const { infoLines, debugLines } = await captureConsole(
    () => pipeline.process(makeUpdate({ avatar: NEW_AVATAR }))
  );
  assert.ok(!infoLines.some((l) => l.includes('头像变更')),
    `info 不得收到头像变更行，实际 ${JSON.stringify(infoLines)}`);
  assert.ok(debugLines.some((l) => l.includes('头像变更')),
    `debug 应收到头像变更行，实际 ${JSON.stringify(debugLines)}`);
  // 落库不变：events 表有 type=friend-update + content_json.type=avatar 记录，含新旧图 URL
  const rows = storage.getFriendProfileChanges(USER_ID, { types: 'avatar' });
  assert.equal(rows.length, 1, `应恰好 1 条 avatar 变更记录，实际 ${rows.length}`);
  const content = JSON.parse(rows[0].content_json);
  assert.equal(content.type, 'avatar');
  assert.equal(content.avatarImageUrl, NEW_AVATAR, '新图 URL 应落库');
  assert.equal(content.previousAvatarImageUrl, OLD_AVATAR, '旧图 URL 应落库');
});

test('防误伤：bio/status 变更仍走 info', async () => {
  initLogger({ dir: path.join(logRoot, 'av-bio-status'), format: 'text', level: 'info' });
  const { infoLines, debugLines } = await captureConsole(
    () => pipeline.process(makeUpdate({ bio: '新简介', status: 'join me', statusDescription: '新状态' }))
  );
  assert.ok(infoLines.some((l) => l.includes('bio变更')), `bio 变更应走 info，实际 ${JSON.stringify(infoLines)}`);
  assert.ok(infoLines.some((l) => l.includes('状态变更')), `status 变更应走 info，实际 ${JSON.stringify(infoLines)}`);
  assert.ok(!infoLines.some((l) => l.includes('头像变更')), 'avatar 未变不应产生头像变更行');
  assert.equal(debugLines.length, 0, `info 级别下不应有 debug 行，实际 ${JSON.stringify(debugLines)}`);
});

test('级别穿透：level=debug 落盘含该行，默认 info 落盘不含', async () => {
  const dirDebug = path.join(logRoot, 'level-debug');
  initLogger({ dir: dirDebug, format: 'text', level: 'debug' });
  await pipeline.process(makeUpdate({ avatar: 'https://api.vrchat.example/avatars/avtr_b2/image.png' }));
  const debugContent = readFileSync(path.join(dirDebug, 'monitor.log'), 'utf8');
  assert.ok(debugContent.includes('头像变更'), 'debug 级别下文件应含头像变更行');
  assert.ok(/DEBUG\s+\[event\].*头像变更/.test(debugContent), `应带 DEBUG [event] 前缀，实际：${debugContent}`);

  const dirInfo = path.join(logRoot, 'level-info');
  initLogger({ dir: dirInfo, format: 'text', level: 'info' });
  // 吞掉 console 输出避免污染测试报告；断言只依赖文件
  const origInfo = console.info;
  const origDebug = console.debug;
  console.info = () => {}; console.debug = () => {};
  try {
    // 同一文件内混入 bio 变更（info 会写行）证明文件活跃，头像行必须缺席
    await pipeline.process(makeUpdate({ avatar: 'https://api.vrchat.example/avatars/avtr_b3/image.png' }));
    await pipeline.process(makeUpdate({ bio: '又换简介' }));
  } finally { console.info = origInfo; console.debug = origDebug; }
  assert.ok(existsSync(path.join(dirInfo, 'monitor.log')), 'info 级别应已创建日志文件（bio 变更写行）');
  const infoContent = readFileSync(path.join(dirInfo, 'monitor.log'), 'utf8');
  assert.ok(infoContent.includes('bio变更'), `同文件应含 info 级 bio 行，实际：${infoContent}`);
  assert.ok(!infoContent.includes('头像变更'), `默认 info 级别文件不得含头像变更行，实际：${infoContent}`);
});
