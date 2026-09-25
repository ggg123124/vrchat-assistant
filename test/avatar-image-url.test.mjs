// avatarImageUrlFromUser 的行为断言（PR #251）
//
// 为什么需要它：新版资料系统把 currentAvatarImageUrl 移除、换成 iconUrl，但【只有 bannerType 为
// avatarBanner 时 iconUrl 才指向模型图】（实测近 3 天分布：avatarBanner 267 / null 106 / color 87）。
// 无条件取 iconUrl 会把【非模型图】当成新模型 ⇒ 既误报「换模型」、又让下游补名拿错 fileId。
// 这些断言直接 import 生产函数；把它改回「无条件取 iconUrl」或「只读旧字段」都会变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarImageUrlFromUser } from '../core/event-pipeline.js';

const ICON = 'https://api.vrchat.cloud/api/1/file/file_aaa/1/';
const OLD = 'https://api.vrchat.cloud/api/1/file/file_old/1/';

test('bannerType=avatarBanner ⇒ iconUrl 指的是模型图，应采用它', () => {
  assert.equal(
    avatarImageUrlFromUser({ bannerType: 'avatarBanner', iconUrl: ICON }),
    ICON,
  );
});

test('bannerType=color / 空 ⇒ iconUrl 不是模型图，不得采用（弱源不产出）', () => {
  assert.equal(avatarImageUrlFromUser({ bannerType: 'color', iconUrl: ICON }), '');
  assert.equal(avatarImageUrlFromUser({ iconUrl: ICON }), '');
  assert.equal(avatarImageUrlFromUser({ bannerType: null, iconUrl: ICON }), '');
});

test('非 avatarBanner 时回落旧字段（老载荷仍可用）', () => {
  assert.equal(
    avatarImageUrlFromUser({ bannerType: 'color', iconUrl: ICON, currentAvatarImageUrl: OLD }),
    OLD,
  );
});

test('bannerType=avatarBanner 时 iconUrl 优先于旧字段', () => {
  assert.equal(
    avatarImageUrlFromUser({ bannerType: 'avatarBanner', iconUrl: ICON, currentAvatarImageUrl: OLD }),
    ICON,
  );
});

test('两者都没有 ⇒ 空串（调用方据此判断「没有模型信息」）', () => {
  assert.equal(avatarImageUrlFromUser({}), '');
  assert.equal(avatarImageUrlFromUser({ bannerType: 'avatarBanner', iconUrl: '' }), '');
});

test('大小写敏感：avatarBanner 必须精确匹配', () => {
  assert.equal(avatarImageUrlFromUser({ bannerType: 'AVATARBANNER', iconUrl: ICON }), '');
});