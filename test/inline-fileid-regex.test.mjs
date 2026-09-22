import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-09-22 #225：**结构性回归护栏**
// 背景：fileId 提取曾在仓库里散落 5 份内联正则，其中 4 份只认 /file/ ✗ ——
// 于是 image 形态（/image/file_xxx/1/256）被静默跳过 ⇒ 模型名/头像补不上（不报错、不写坏数据）✗。
// #223 修好了共享实现 avatarFileId()，本测试把"调用点也收敛"这件事**锁死**：
// 一旦有人在 start-monitor.js / core/*.js 里再手写一份旧正则，测试立刻变红 ✓。
const LEGACY = /\/file\/\(file_/;   // 只认 /file/ 的旧写法（avatarFileId 内部那一份除外）
const FILES = ['start-monitor.js', 'core/dashboard-services.js', 'core/friend-refresh.js', 'core/event-pipeline.js'];

test('不得再出现"只认 /file/ 的"内联 fileId 正则（#225）', () => {
  const hits = [];
  for (const f of FILES) {
    let src;
    try { src = readFileSync(f, 'utf-8'); } catch { continue; }
    src.split('\n').forEach((line, i) => {
      if (LEGACY.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.equal(hits.length, 0, '发现旧正则（应改用 core/img-util.js 的 avatarFileId ✓）：\n' + hits.join('\n'));
});

// 注：avatarFileId 对 /image/ 的形态支持由 PR #223 引入（本 PR 只做调用点收敛 + 结构护栏）✓
// 因此这里**不重复写行为断言**：在 #223 合并前它会红 ✗，合并后由 #223 自带用例覆盖 ✓
