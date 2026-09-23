import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-09-23 评审 🔴（head 1c74f0a）：抽成纯函数时漏了 import ⇒ 调用点抛 ReferenceError
// 被外层 catch 静默吞掉 ⇒ 修复完全不生效，而 232/232 测试全绿（因为它们直接 import 纯函数 ✓）。
// ⇒ 本用例守住「start-monitor.js 里用到的跨模块标识符必须有对应 import」。

const SRC = readFileSync(new URL('../start-monitor.js', import.meta.url), 'utf8');

test('start-monitor.js：调用了 decideTrackedFail 就必须有 import（防静默 ReferenceError）', () => {
  const called = /\bdecideTrackedFail\s*\(/.test(SRC);
  assert.ok(called, '前提：调用点应存在（否则本用例失效）');
  assert.match(SRC, /import\s*\{[^}]*\bdecideTrackedFail\b[^}]*\}\s*from\s*'\.\/core\/tracked-fail-policy\.js'/, '必须 import decideTrackedFail');
});

test('通用检查：tracked 刷新里引用的策略标识符都已 import', () => {
  const need = ['decideTrackedFail'];
  const importBlock = SRC.split('\n').filter((l) => l.startsWith('import ')).join('\n');
  for (const name of need) {
    if (!new RegExp('\\b' + name + '\\s*\\(').test(SRC)) continue;
    assert.ok(importBlock.includes(name), name + ' 被调用但没有 import');
  }
});