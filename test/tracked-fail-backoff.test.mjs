import test from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../core/storage.js';

// 2026-09-23 评审 ⚠️1：不要硬编码 /tmp —— 本仓其余测试统一走 os.tmpdir()（Windows 上当前盘符根可能没有 \tmp）
const TMP = () => path.join(os.tmpdir(), 'trk-241-' + process.pid + '.db');
const cleanup = () => { try { if (existsSync(TMP())) unlinkSync(TMP()); } catch { /* ignore */ } };

test('迁移幂等：tracked_non_friends 含 fail_count（issue #241）', async () => {
  cleanup();
  const a = new Storage();
  await a.init(TMP());
  const c1 = a.query('PRAGMA table_info(tracked_non_friends)').map((c) => c.name);
  assert.ok(c1.includes('fail_count'), '第 1 次 init 后应含 fail_count');
  const b = new Storage();
  await b.init(TMP());            // 幂等：旧库再 init 一次不得报错、不得重复列
  const c2 = b.query('PRAGMA table_info(tracked_non_friends)').map((c) => c.name);
  assert.equal(new Set(c2).size, c2.length, '不得有重复列');
  assert.deepEqual(c2, c1, '两次 init 的列集合应一致');
  cleanup();
});

test('连续 3 次非 200 ⇒ 软删除；成功 ⇒ fail_count 清零（issue #241 的 SQL 语义）', async () => {
  cleanup();
  const s = new Storage();
  await s.init(TMP());
  s.run('INSERT INTO tracked_non_friends (user_id, display_name, removed_at, fail_count) VALUES ($u,$d,$r,$n)',
    { $u: 'usr_dead', $d: '已失效用户', $r: '', $n: 0 });
  for (let i = 1; i <= 3; i++) {
    const fails = (s.query('SELECT fail_count FROM tracked_non_friends WHERE user_id=$u', { $u: 'usr_dead' })[0].fail_count || 0) + 1;
    if (fails >= 3) s.run('UPDATE tracked_non_friends SET removed_at=$t, fail_count=$n WHERE user_id=$u', { $t: new Date().toISOString(), $n: fails, $u: 'usr_dead' });
    else s.run('UPDATE tracked_non_friends SET fail_count=$n WHERE user_id=$u', { $n: fails, $u: 'usr_dead' });
  }
  const dead = s.query('SELECT removed_at, fail_count FROM tracked_non_friends WHERE user_id=$u', { $u: 'usr_dead' })[0];
  assert.ok(dead.removed_at, '3 次失败后应已软删除（移出刷新列表）');
  assert.equal(dead.fail_count, 3);
  assert.equal(s.query("SELECT COUNT(*) n FROM tracked_non_friends WHERE removed_at=''")[0].n, 0, '刷新列表里不应再有它');
  // 成功即清零：模拟一条曾被误判但恢复的条目
  s.run('INSERT INTO tracked_non_friends (user_id, display_name, removed_at, fail_count) VALUES ($u,$d,$r,$n)',
    { $u: 'usr_ok', $d: '恢复用户', $r: '', $n: 2 });
  s.run('UPDATE tracked_non_friends SET fail_count = 0 WHERE user_id = $u', { $u: 'usr_ok' });
  assert.equal(s.query('SELECT fail_count FROM tracked_non_friends WHERE user_id=$u', { $u: 'usr_ok' })[0].fail_count, 0, '成功应清零');
  assert.ok(s.query('SELECT removed_at FROM tracked_non_friends WHERE user_id=$u', { $u: 'usr_ok' })[0].removed_at === '', '恢复的条目仍在刷新列表');
  cleanup();
});