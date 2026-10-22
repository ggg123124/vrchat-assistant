/**
 * search-bio-unknown.test.mjs — issue #275：搜索结果不再伪造「空简介」
 *
 * 背景：#273 修复了 bio 已移出 user 对象的问题；两处搜索结果预览仍读该字段，
 * 导致预览恒空且把「未知」渲染成「确认没写」。本用例锁定收尾口径：
 *   - search_users 结果保留 bio 键，但值固定 null（未知）；
 *   - 看板用户搜索副标题只含好友标记，不再拼接简介。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ctx } from '../core/server-context.js';
import { handleSearchUsers } from '../core/tools/friends.js';
import { userSearchSub } from '../plugins/official/web-dashboard/server/routes/search.js';

const SELF = 'usr_01234567-0123-4123-8123-0123456789ab';

test('search_users：bio 固定 null（未知），不读 user 对象上已不存在的字段', async () => {
  const prevApi = ctx.api;
  const prevStorage = ctx.storage;
  ctx.api = {
    _request: async () => ({
      status: 200,
      data: [{
        id: SELF,
        displayName: '好友A',
        bio: '上游残留的 bio 不应被采用',
        status: 'active',
        isFriend: true,
      }],
    }),
  };
  ctx.storage = { searchFriends: () => [] };
  try {
    const r = await handleSearchUsers({ query: '好友A' });
    assert.equal(r.results.length, 1);
    assert.ok('bio' in r.results[0], '返回结构保留 bio 键');
    assert.equal(r.results[0].bio, null, 'null = 未知，不是空字符串');
  } finally {
    ctx.api = prevApi;
    ctx.storage = prevStorage;
  }
});

test('看板用户搜索副标题只含好友标记，不拼接简介', () => {
  assert.equal(userSearchSub({ isFriend: true, bio: '任意简介' }), '好友');
  assert.equal(userSearchSub({ isFriend: false, bio: '任意简介' }), '');
  assert.doesNotMatch(userSearchSub({ isFriend: true, bio: '任意简介' }), /任意简介/);
});

test('看板调用点仍在：index.js 用 userSearchSub 且不再读 u.bio（防「函数写了没人调」）', () => {
  const src = fs.readFileSync(new URL('../plugins/official/web-dashboard/index.js', import.meta.url), 'utf8');
  assert.match(src, /sub: userSearchSub\(u\)/, '调用点必须接上');
  assert.doesNotMatch(src, /u\.bio/, '不得回退到已不在 user 对象里的字段');
});
