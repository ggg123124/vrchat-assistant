// VRC Search（search.vrcwwt.com）卡片解析的行为断言（issue #320）
// 2026-11 站点改版：卡片从 `article.list-group-item.result-row-event` 换成 `article.event-card`
// （class 还带 is-live 等修饰），时间/群组/日历改由 data-* 属性承载。旧解析器对新页面恒 0 命中。
// 夹具 test/fixtures/vrcsearch-events.html 为真站抓取（2 张卡，均 2026-11-26），不联网。
// 关键口径：data-starts/data-ends 是 UTC，必须落成「无 Z 无毫秒」的 naive 串——
// 带 Z 会让 eventTzInfo 走 aware 分支，北京时间列语义失真（VRC Search 基准偏移=0）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVrcSearchCards, eventTzInfo } from '../plugins/official/events/lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(HERE, 'fixtures', 'vrcsearch-events.html'), 'utf8');
const events = parseVrcSearchCards(html, 'music', 'week', 'multi');

test('真站夹具：2 张 event-card 全部解析出来', () => {
  assert.equal(events.length, 2);
});

test('第 1 张（is-live、无 .ec-lang）：字段逐个对齐', () => {
  const e = events[0];
  assert.equal(e.name, 'Fun');
  assert.equal(e.start, '2026-11-26T00:00:00');
  assert.equal(e.end, '2026-11-26T04:00:00');
  assert.equal(e.group_id, 'grp_6a33ca2b-31ea-4f46-aac9-36aa964979e9');
  assert.equal(e.cal_id, 'cal_d6ba718c-c923-404b-9d6a-93900e3ca640');
  assert.equal(e.group_name, 'White Rose Mafia');
  assert.deepEqual(e.languages, [], '缺 .ec-lang 必须是 []，不能抛错也不能塞别的');
  assert.ok(e.icon_url.includes('file_5f7bce56'), `icon_url 应取自 .ec-host-icon 的 img，实际=${e.icon_url}`);
  assert.equal(e.src, 'VRC Search');
  assert.equal(e.category, 'music');
  assert.equal(e.category_zh, '音乐');
  assert.equal(e.lang, 'multi');
});

test('第 2 张（带 .ec-lang）：语言/名称/时间正确', () => {
  const e = events[1];
  assert.equal(e.name, "TECKFADER's Studio Vibe Night");
  assert.deepEqual(e.languages, ['英語']);
  assert.equal(e.start, '2026-11-26T01:00:00');
  assert.equal(e.end, '2026-11-26T04:00:00');
});

test('start/end 一律 naive：不含 Z、不含毫秒点', () => {
  for (const e of events) {
    assert.ok(!e.start.includes('Z'), `start 不得带 Z：${e.start}`);
    assert.ok(!e.start.includes('.'), `start 不得带毫秒：${e.start}`);
    if (e.end) {
      assert.ok(!e.end.includes('Z'), `end 不得带 Z：${e.end}`);
      assert.ok(!e.end.includes('.'), `end 不得带毫秒：${e.end}`);
    }
  }
});

test('UTC 口径验证：00:00Z 的北京列必须是 08:00', () => {
  const tz = eventTzInfo(events[0]);
  assert.equal(tz.start_bj, '11-26 08:00');
});

test('缺 data-starts 的卡片被跳过，同页正常卡不受影响', () => {
  const page = [
    '<article class="event-card" data-result-id="grp_bad/cal_bad"><h3 class="ec-title">Bad</h3><p class="ec-desc">x</p></article>',
    '<article class="event-card is-live" data-starts="2026-11-27T10:00:00.000Z" data-ends="2026-11-27T12:00:00.000Z">',
    '<h3 class="ec-title">Good</h3></article>',
  ].join('\n');
  const out = parseVrcSearchCards(page, 'music', 'week', 'zh');
  assert.equal(out.length, 1, '缺 data-starts 的卡必须整卡跳过');
  assert.equal(out[0].name, 'Good');
  assert.equal(out[0].start, '2026-11-27T10:00:00');
});

test('旧结构 result-row-event 不再产出（防回退）', () => {
  const legacy = [
    '<article class="list-group-item result-row result-row-event">',
    '<div class="result-row-title">Old</div>',
    '開始 2026-11-26 08:00',
    '</article>',
  ].join('\n');
  assert.deepEqual(parseVrcSearchCards(legacy, 'music', 'week', 'multi'), []);
});
