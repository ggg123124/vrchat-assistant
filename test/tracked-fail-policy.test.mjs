import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideTrackedFail, TRACKED_FAIL_LIMIT } from '../core/tracked-fail-policy.js';

// 2026-09-23 评审 💡2：直接驱动**生产函数**（不再复刻 SQL）——生产若把 >= 改成 >、
// 或改成对 429/5xx 也计数，这些用例都会变红。

test('404 连续累计：第 1/2 次不淘汰，第 K 次淘汰', () => {
  let cur = 0;
  for (let i = 1; i <= TRACKED_FAIL_LIMIT; i++) {
    const d = decideTrackedFail({ failCount: cur, status: 404 });
    assert.equal(d.next, i);
    assert.equal(d.permanent, true);
    assert.equal(d.remove, i >= TRACKED_FAIL_LIMIT);
    cur = d.next;
  }
  assert.equal(cur, TRACKED_FAIL_LIMIT);
});

test('429 / 5xx / 403 / 200-但含 error 一律不累计、不淘汰（评审 ⚠️2 的关键取舍）', () => {
  const cases = [{ status: 429 }, { status: 500 }, { status: 503 }, { status: 403 }, { status: 200, hasDataError: true }];
  for (const p of cases) {
    const d = decideTrackedFail(Object.assign({ failCount: 2 }, p));
    assert.equal(d.remove, false, JSON.stringify(p) + ' 不得淘汰');
    assert.equal(d.next, 2, JSON.stringify(p) + ' 不得累计');
    assert.equal(d.permanent, false);
    assert.ok(d.reason && d.reason.length > 0);
  }
});

test('文案不再出现自相矛盾的 HTTP 200（评审 💡1）', () => {
  const d = decideTrackedFail({ failCount: 0, status: 200, hasDataError: true });
  assert.ok(!/HTTP 200/.test(d.reason), '200 分支不得写成 HTTP 200：' + d.reason);
  assert.match(decideTrackedFail({ failCount: 0, status: 404 }).reason, /404/);
});

test('残留计数会「一次失败即淘汰」——故重新激活路径必须清零（评审 ⚠️1）', () => {
  assert.equal(decideTrackedFail({ failCount: TRACKED_FAIL_LIMIT, status: 404 }).remove, true);
  assert.equal(decideTrackedFail({ failCount: 0, status: 404 }).remove, false);
});

test('两条重新激活路径都必须同时清零 fail_count（源码断言）', () => {
  for (const f of ['../core/dashboard-services.js', '../core/event-pipeline.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(/removed_at = '', fail_count = 0/.test(src), f + ' 应同时清零 fail_count');
  }
});