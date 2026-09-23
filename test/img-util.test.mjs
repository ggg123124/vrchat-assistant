/**
 * test/img-util.test.mjs — avatarFileId 必须同时认 /file/ 与 /image/ 两种形态
 *
 * 背景（2026-09-22 实测）：VRChat 模型名解析走 GET /file/{fileId}；而模型图 URL 有两种形态——
 *   https://api.vrchat.cloud/api/1/file/file_XXX/1/file     （段名 file）
 *   https://api.vrchat.cloud/api/1/image/file_XXX/1/256     （段名 image，更常见）
 * 旧正则只认 /file/ ⇒ image 形态一律返回 null ⇒ 上层拿不到 fileId ⇒ 解析失败（用户报障「动态里全是未知模型」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarFileId, imgProxy } from '../core/img-util.js';

const ID = 'file_01234567-89ab-cdef-0123-456789abcdef';

test('file 形态', () => {
  assert.equal(avatarFileId(`https://api.vrchat.cloud/api/1/file/${ID}/1/file`), ID);
});

test('image 形态（本次修复点）', () => {
  assert.equal(avatarFileId(`https://api.vrchat.cloud/api/1/image/${ID}/1/256`), ID);
});

test('经本服务代理后的 URL（先解码再提取）', () => {
  const raw = `https://api.vrchat.cloud/api/1/image/${ID}/1/256`;
  assert.equal(avatarFileId(imgProxy(raw)), ID);
});

test('无 fileId / 空值', () => {
  assert.equal(avatarFileId(''), null);
  assert.equal(avatarFileId(null), null);
  assert.equal(avatarFileId('https://api.vrchat.cloud/api/1/image/not_a_file/1/256'), null);
});
