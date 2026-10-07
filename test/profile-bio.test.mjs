/**
 * test/profile-bio.test.mjs — 简介(bio)的读取与判定语义（2026-10-07）
 *
 * 背景：新版资料系统把 bio 移出 user 对象（WS 与 GET /users/{id} 都没有该键），唯一来源是
 * GET /profile/{userId}。本用例锁住 core/profile-bio.js 的两条约定：
 *   ① 只有「200 且响应带 bio 键且是字符串」才算真值 —— 空串 = 对方确实没写简介；
 *   ② 其余一律 undefined ＝ **未知** ⇒ 调用方不得 diff、不得写库（否则会把「拿不到」写成「被清空」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchProfileBio, bioChanged } from '../core/profile-bio.js';

const apiOf = (responder) => ({ _request: async (m, url) => { assert.equal(m, 'GET'); return responder(url); } });

test('200 + bio 键 ⇒ 返回真值（空串也算真值：对方确实没写简介）', async () => {
  const api = apiOf((url) => { assert.match(url, /^\/profile\/usr_/); return { status: 200, data: { id: 'usr_1', bio: 'hello' } }; });
  assert.equal(await fetchProfileBio(api, 'usr_1'), 'hello');
  assert.equal(await fetchProfileBio(apiOf(() => ({ status: 200, data: { bio: '' } })), 'usr_1'), '');
});

test('200 但响应缺 bio 键 ⇒ undefined（未知，不是空）', async () => {
  assert.equal(await fetchProfileBio(apiOf(() => ({ status: 200, data: { id: 'usr_1', displayName: 'A' } })), 'usr_1'), undefined);
});

test('非 200 / 抛错 / bio 非字符串 / 参数缺失 ⇒ undefined', async () => {
  assert.equal(await fetchProfileBio(apiOf(() => ({ status: 404, data: null })), 'usr_1'), undefined);
  assert.equal(await fetchProfileBio(apiOf(() => { throw new Error('timeout'); }), 'usr_1'), undefined);
  assert.equal(await fetchProfileBio(apiOf(() => ({ status: 200, data: { bio: null } })), 'usr_1'), undefined);
  assert.equal(await fetchProfileBio(apiOf(() => ({ status: 500, data: {} })), 'usr_1'), undefined);
  assert.equal(await fetchProfileBio(null, 'usr_1'), undefined);
  assert.equal(await fetchProfileBio(apiOf(() => ({ status: 200, data: { bio: 'x' } })), ''), undefined);
});

test('bioChanged：未知一律 false（缺字段不得当成「变空」）；有基线且不同才真', () => {
  assert.equal(bioChanged('old', undefined), false, '未知 ⇒ 不得当成被清空（本次修复的核心）');
  assert.equal(bioChanged('old', ''), true, '显式空串 = 真实清空');
  assert.equal(bioChanged('old', 'new'), true);
  assert.equal(bioChanged('old', 'old'), false);
  assert.equal(bioChanged('', 'new'), false, '无基线 ⇒ 只建基线、不产事件');
  assert.equal(bioChanged('', undefined), false);
});

test('userId 进 URL 前做编码（不注入路径）', async () => {
  let seen = '';
  const api = { _request: async (m, url) => { seen = url; return { status: 200, data: { bio: 'x' } }; } };
  await fetchProfileBio(api, 'usr_a/b');
  assert.equal(seen, '/profile/usr_a%2Fb');
});
