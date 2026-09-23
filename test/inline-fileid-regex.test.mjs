import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';   // 2026-09-22 评审 💡：清单存在性断言

// 2026-09-22 #225：**结构性回归护栏**
// 背景：fileId 提取曾在仓库里散落 5 份内联正则，其中 4 份只认 /file/ ✗ ——
// 于是 image 形态（/image/file_xxx/1/256）被静默跳过 ⇒ 模型名/头像补不上（不报错、不写坏数据）✗。
// #223 修好了共享实现 avatarFileId()，本测试把"调用点也收敛"这件事**锁死**：
// 一旦有人在 start-monitor.js / core/*.js 里再手写一份旧正则，测试立刻变红 ✓。
// 2026-09-22 评审纠正：原写法用正则判定，转义易失 ⇒ 实测会恒绿 ✗（注入真·旧正则仍 pass）。
// 改用【纯子串】比对：只要源码里出现下面这段字面量就命中 —— 不依赖任何转义。
const LEGACY_TEXT = '\\/file\\/(file_';   // = 字面量 \/file\/(file_（旧正则的源码文本；avatarFileId 内部那份在 core/img-util.js，不在扫描清单）   // 旧写法的字面量特征（avatarFileId 内部那一份在 core/img-util.js，不在扫描清单里）
const FILES = ['start-monitor.js', 'core/dashboard-services.js', 'core/event-pipeline.js'];

test('门禁清单不得包含不存在的文件（否则该条目永久静默）', async () => {
  const missing = [];
  for (const f of FILES) {
    try { await access(f); } catch { missing.push(f); }
  }
  assert.equal(missing.length, 0, '清单里这些文件不存在，条目永远扫不到任何东西：' + missing.join(', '));
});
test('不得再出现"只认 /file/ 的"内联 fileId 正则（#225）', () => {
  const hits = [];
  for (const f of FILES) {
    let src;
    try { src = readFileSync(f, 'utf-8'); } catch { continue; }
    src.split('\n').forEach((line, i) => {
      if (line.includes(LEGACY_TEXT)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.equal(hits.length, 0, '发现旧正则（应改用 core/img-util.js 的 avatarFileId ✓）：\n' + hits.join('\n'));
});

// 注：avatarFileId 对 /image/ 的形态支持由 PR #223 引入（本 PR 只做调用点收敛 + 结构护栏）✓
// 因此这里**不重复写行为断言**：在 #223 合并前它会红 ✗，合并后由 #223 自带用例覆盖 ✓
