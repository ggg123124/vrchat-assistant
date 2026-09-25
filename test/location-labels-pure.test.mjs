// 位置标签纯函数的行为断言（审查方 #250 建议：源码正则钉不住「能不能跑」与主行为）
// 直接 import 生产用的 utils.js；把主行为改回旧写法就一定变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { specialLocationLabel, parseLoc, locLabelFull, instanceLabel } from '../plugins/official/web-dashboard/ui/src/utils.js';

test('纯值形态：private 必须给「私人房间」', () => {
  assert.equal(specialLocationLabel('private'), '私人房间');
});

test('实例串形态：~private(usr_x) 也必须给「私人房间」', () => {
  const loc = 'wrld_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:12345~private(usr_1111)';
  assert.equal(parseLoc(loc).type, 'private', '前置：parseLoc 必须把它判成 private');
  assert.equal(specialLocationLabel(loc), '私人房间');
});

test('公开实例不得被改写（返回空，交给调用方回退世界名）', () => {
  const loc = 'wrld_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:12345~region(us)';
  assert.equal(parseLoc(loc).type, 'public');
  assert.equal(specialLocationLabel(loc), '');
});

test('其余纯值形态也要给人话', () => {
  assert.equal(specialLocationLabel('offline'), '离线');
  assert.equal(specialLocationLabel('offline:offline'), '网页在线');
  assert.equal(specialLocationLabel('traveling'), '传送中');
  assert.equal(specialLocationLabel('local'), '本地房间');
});

test('locLabelFull 拼出「公开 · US · 12345」', () => {
  const loc = 'wrld_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:12345~region(us)';
  assert.equal(locLabelFull(loc), instanceLabel('public') + ' · US · 12345');
  assert.match(locLabelFull(loc), /^公开 · US · 12345$/);
});

test('空/无类型输入不得抛错', () => {
  assert.equal(specialLocationLabel(''), '');
  assert.equal(locLabelFull(''), '');
});

// 已知行为差异（不在本 PR 范围内，如实记录以免后来者以为是本 PR 的缺陷）：
//   locLabelFull('…~invite(usr_x)') / '…~private'（无 ownerId）时，parseLoc 判 type='public'
//   ⇒ specialLocationLabel 不返回「私人房间」。当前实现只对 parseLoc 判出 private/invite/invite+
//   的形态生效；这两种形态 parseLoc 不给那些 type，需要另案评估（改 parseLoc 影响面更大）。