/**
 * deident-check.test.mjs — scripts/check-deident.mjs 的判据回归
 *
 * 覆盖 issue #308 §3 的契约：
 *   - ID 轨：v4 形态的非白名单 usr_ 必须红；统一占位模板必须绿；wrld_ 不在范围内。
 *   - 昵称轨：未提供 token 必须 skipped（不是 pass）；命中必须红；边界不误报；CRLF 归一化。
 *   - 双向变异自证：先在干净夹具上断言绿，再真实改文件并断言红（先证变异已应用）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  runCheck,
  formatReport,
  normalizeLine,
  readTokens,
  listTrackedFiles,
  PLACEHOLDER_USR,
} from '../scripts/check-deident.mjs';

// 合成 v4 形态 + 运行时拼接：源码里不出现完整 ID，判据不会把自己的测试夹具判红
const BAD_USR = 'usr_' + '11111111-2222-4333-8444-' + '555555555555';

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrc-deident-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { root, files: Object.keys(files) };
}

function withFixture(files, fn) {
  const f = fixture(files);
  try {
    return fn(f);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

test('ID 轨：非白名单 v4 userId → fail（定位到文件与行号）', () => {
  withFixture({ 'a.test.mjs': `const id = '${BAD_USR}';\n` }, ({ root, files }) => {
    const r = runCheck({ root, files, tokens: ['x'] });
    assert.equal(r.status, 'fail');
    assert.equal(r.idFindings.length, 1);
    assert.equal(r.idFindings[0].file, 'a.test.mjs');
    assert.equal(r.idFindings[0].line, 1);
    assert.equal(r.idFindings[0].value, BAD_USR);
  });
});

test('ID 轨：统一占位模板 → pass', () => {
  withFixture({ 'a.test.mjs': `const id = '${PLACEHOLDER_USR}';\n` }, ({ root, files }) => {
    const r = runCheck({ root, files, tokens: ['x'] });
    assert.equal(r.status, 'pass');
    assert.equal(r.idFindings.length, 0);
  });
});

test('ID 轨：wrld_ 公开世界 ID 不在范围内', () => {
  withFixture({ 'a.test.mjs': "const w = 'wrld_f2de4d2d-324b-485f-a8bf-ec93bed3382a';\n" }, ({ root, files }) => {
    const r = runCheck({ root, files, tokens: ['x'] });
    assert.equal(r.status, 'pass');
    assert.equal(r.idFindings.length, 0);
  });
});

test('昵称轨：未提供 token → skipped（退出码 0），报告显式计数且不写 PASS', () => {
  withFixture({ 'a.test.mjs': "const name = '任意文本';\n" }, ({ root, files }) => {
    const r = runCheck({ root, files, tokens: [] });
    assert.equal(r.status, 'skipped');
    assert.equal(r.skipped.nickname, true);
    assert.equal(r.nicknameScanned, 0);
    const report = formatReport(r);
    assert.match(report, /skipped（未提供 token）/);
    assert.match(report, /结果：SKIPPED/);
    assert.doesNotMatch(report, /结果：PASS/);
  });
});

test('昵称轨：提供 token 且命中 → fail', () => {
  withFixture({ 'a.test.mjs': "const name = '好友A';\n" }, ({ root, files }) => {
    const r = runCheck({ root, files, tokens: ['好友A'] });
    assert.equal(r.status, 'fail');
    assert.equal(r.nicknameFindings.length, 1);
    assert.equal(r.nicknameFindings[0].line, 1);
  });
});

test('昵称轨：边界不误报（「好友A一起」不命中 token「好友A」）', () => {
  withFixture({ 'a.test.mjs': "const name = '好友A一起';\n" }, ({ root, files }) => {
    const r = runCheck({ root, files, tokens: ['好友A'] });
    assert.equal(r.status, 'pass');
    assert.equal(r.nicknameFindings.length, 0);
  });
});

test('昵称轨：CRLF 行尾不影响命中与行号', () => {
  withFixture({ 'a.txt': 'line1\r\n好友A\r\nline3\r\n' }, ({ root, files }) => {
    const r = runCheck({ root, files, tokens: ['好友A'] });
    assert.equal(r.status, 'fail');
    assert.equal(r.nicknameFindings[0].line, 2);
  });
});

test('归一化只去行尾 CR', () => {
  assert.equal(normalizeLine('abc\r'), 'abc');
  assert.equal(normalizeLine('abc'), 'abc');
  assert.equal(normalizeLine('a\rb'), 'a\rb');
});

test('双向变异自证：先绿 → 应用真实变异 → 红', () => {
  withFixture({ 'a.test.mjs': `const id = '${PLACEHOLDER_USR}';\n` }, ({ root, files }) => {
    const before = runCheck({ root, files, tokens: ['x'] });
    assert.equal(before.status, 'pass', '基线必须绿');

    const abs = path.join(root, 'a.test.mjs');
    fs.appendFileSync(abs, `const leaked = '${BAD_USR}';\n`);
    // 先断言变异真的落盘，再做判定（避免「变异没应用也绿/红」的假自证）
    assert.match(fs.readFileSync(abs, 'utf8'), new RegExp(BAD_USR), '变异必须先真实应用');

    const after = runCheck({ root, files, tokens: ['x'] });
    assert.equal(after.status, 'fail', '应用变异后必须红');
    assert.equal(after.idFindings.length, 1);
  });
});

test('readTokens：inline 逗号分隔 / 文件每行一个（# 注释忽略）', () => {
  assert.deepEqual(readTokens({ VRC_DEIDENT_TOKENS: '好友A, 好友B' }), ['好友A', '好友B']);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrc-deident-tokens-'));
  try {
    const file = path.join(root, 'tokens.txt');
    fs.writeFileSync(file, '# 本地 token，不入库\n好友A\r\n好友B\n\n');
    assert.deepEqual(readTokens({ VRC_DEIDENT_TOKENS_FILE: file }), ['好友A', '好友B']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('非 git 目录：枚举失败 fail-closed（明确报错，不降级 skipped）', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrc-deident-nogit-'));
  try {
    // 若临时目录恰好在某个工作树内，git ls-files 会成功，本用例不适用
    let inside = false;
    try {
      inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true';
    } catch { /* 不是工作树 = 目标场景 */ }
    if (inside) {
      t.skip('临时目录位于 git 工作树内，跳过');
      return;
    }
    assert.throws(
      () => listTrackedFiles(root),
      (e) => e.code === 'DEIDENT_NOT_GIT' && /不是 git 工作树/.test(e.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
