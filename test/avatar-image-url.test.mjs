// avatarImageUrlFromUser 的行为断言 + 语义护栏（PR #251）
//
// 为什么需要它：新版资料系统把 currentAvatarImageUrl 移除、换成 iconUrl，但【只有 bannerType 为
// avatarBanner 时 iconUrl 才指向模型图】。这里有两层断言：
//   ① 行为：不同 bannerType 下取值正确；
//   ② 语义护栏：取不到时必须是 undefined，不能是空串 —— 空串在调用方会被当成"新值是空的"，
//      与旧值 diff 出【空图的「更换模型」事件】，并在 upsert 里把模型图基线清空。
// 把语义改回空串、或把 upsert 改回"无条件写该列"，都会让本文件变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { avatarImageUrlFromUser } from '../core/event-pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EP = readFileSync(path.join(__dirname, '..', 'core', 'event-pipeline.js'), 'utf8');

const ICON = 'https://api.vrchat.cloud/api/1/file/file_aaa/1/';
const OLD = 'https://api.vrchat.cloud/api/1/file/file_old/1/';

test('bannerType=avatarBanner ⇒ iconUrl 指的是模型图，应采用它', () => {
  assert.equal(avatarImageUrlFromUser({ bannerType: 'avatarBanner', iconUrl: ICON }), ICON);
});

test('bannerType=color / customImage / 空 ⇒ iconUrl 不是模型图，不得采用', () => {
  assert.notEqual(avatarImageUrlFromUser({ bannerType: 'color', iconUrl: ICON }), ICON);
  assert.notEqual(avatarImageUrlFromUser({ bannerType: 'customImage', iconUrl: ICON }), ICON);
  assert.notEqual(avatarImageUrlFromUser({ iconUrl: ICON }), ICON);
  assert.notEqual(avatarImageUrlFromUser({ bannerType: null, iconUrl: ICON }), ICON);
});

test('非 avatarBanner 时回落旧字段（老载荷仍可用）', () => {
  assert.equal(avatarImageUrlFromUser({ bannerType: 'color', iconUrl: ICON, currentAvatarImageUrl: OLD }), OLD);
});

test('bannerType=avatarBanner 时 iconUrl 优先于旧字段', () => {
  assert.equal(avatarImageUrlFromUser({ bannerType: 'avatarBanner', iconUrl: ICON, currentAvatarImageUrl: OLD }), ICON);
});

test('取不到模型信息 ⇒ 必须返回 undefined（返回空串会被当成"换成空模型"）', () => {
  assert.equal(avatarImageUrlFromUser({}), undefined);
  assert.equal(avatarImageUrlFromUser(null), undefined);
  assert.equal(avatarImageUrlFromUser({ bannerType: 'avatarBanner', iconUrl: '' }), undefined);
  assert.equal(avatarImageUrlFromUser({ bannerType: 'color', iconUrl: ICON, currentAvatarImageUrl: '' }), undefined);
  assert.notEqual(avatarImageUrlFromUser({}), '');
});

test('大小写敏感：avatarBanner 必须精确匹配', () => {
  assert.notEqual(avatarImageUrlFromUser({ bannerType: 'AVATARBANNER', iconUrl: ICON }), ICON);
});

test('avatarChanged 判据必须排除 undefined（否则会造出"空图更换模型"事件）', () => {
  assert.match(EP, /const avatarChanged = newAvatarUrl !== undefined && prev\.avatar_image_url/);
});

test('资料回写的 upsert 必须对模型图用 partial（不得无条件写该列）', () => {
  // _handleUpdate 的 upsert：展开式 partial
  assert.match(EP, /\.\.\.\(newAvatarUrl \? \{ avatarImageUrl: newAvatarUrl \} : \{\}\)/);
  // 禁止历史形态：无条件写、且用已移除字段
  assert.doesNotMatch(EP, /^\s*avatarImageUrl: userObj\.currentAvatarImageUrl \|\| '',$/m);
});

test('回写 patch 也必须"取不到就不写"（走 put 的空值过滤，避免清空基线）', () => {
  assert.match(EP, /const syncAvatarUrl = avatarImageUrlFromUser\(userObj\)/);
  assert.match(EP, /put\('avatarImageUrl', syncAvatarUrl\)/);
});

test('userIcon 的回写也必须是 partial（字段改名后裸引用恒空）', () => {
  assert.match(EP, /\.\.\.\(userObj\.iconUrl \|\| userObj\.userIcon \? \{ userIcon: userObj\.iconUrl \|\| userObj\.userIcon \} : \{\}\)/);
  assert.doesNotMatch(EP, /^\s*userIcon: userObj\.userIcon \|\| '',$/m);
});
