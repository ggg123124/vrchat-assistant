// 2026-09-22 PR #222 审核 ⚠️1 的回应：把"信任等级 tag → 展示名"的映射用用例钉住。
// 审核方的变异实验：把 TRUST_FROM_TAG 整体写高一档（trusted→Trusted User、known→Known User），
// 本 PR 内**全部测试依然全绿** ✗ ⇒ 说明当时没有任何用例锁住这张表 ✓。本文件就是那条例外。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustFromTags } from '../core/friend-refresh.js';

// 权威口径：VRCX src/shared/utils/userTransforms.js computeTrustLevel
//（veteran→Trusted User / trusted→Known User / known→User / basic→New User）
test('信任等级标签→展示名：逐档对齐（不得高一档）', () => {
  assert.equal(trustFromTags(['system_trust_basic']), 'New User');
  assert.equal(trustFromTags(['system_trust_known']), 'User');
  assert.equal(trustFromTags(['system_trust_trusted']), 'Known User');
  assert.equal(trustFromTags(['system_trust_veteran']), 'Trusted User');
  assert.equal(trustFromTags(['system_trust_legend']), 'Trusted User');
});

test('信任等级标签→展示名：混合标签取最高档', () => {
  assert.equal(trustFromTags(['system_trust_basic', 'system_trust_trusted']), 'Known User');
  assert.equal(trustFromTags(['system_trust_known', 'system_trust_legend']), 'Trusted User');
});

test('信任等级标签→展示名：未知/空标签不得给出等级', () => {
  assert.equal(trustFromTags([]), '');
  assert.equal(trustFromTags(['some_other_tag']), '');
  assert.equal(trustFromTags(undefined), '');
});

// 变异对照：这正是审核方指出的"错一档"表。若有人把它写回实现，上面第一个用例必然失败 ✓
test('变异对照：错一档的映射与实现不一致（本用例存在的意义）', () => {
  const oneTierHigh = { system_trust_known: 'Known User', system_trust_trusted: 'Trusted User' };
  assert.notEqual(trustFromTags(['system_trust_known']), oneTierHigh.system_trust_known);
  assert.notEqual(trustFromTags(['system_trust_trusted']), oneTierHigh.system_trust_trusted);
});
