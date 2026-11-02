/**
 * seq-guard.test.js —— 「只认最新一次异步结果」的回归（2026-11-02）
 *
 * 这条保护的场景：弹窗切换对象时，先发出的请求后返回会覆盖新对象的数据。
 * 本模块是那段逻辑的唯一实现，UserDialog 的 loadProfile / loadEvents 都用它。
 */
import { describe, it, expect } from 'vitest';
import { createSeqGuard } from './seq-guard.js';

describe('createSeqGuard', () => {
  it('同键连续两次请求：只有第二次算当前', () => {
    const g = createSeqGuard();
    const a = g.begin('usr_A');
    const b = g.begin('usr_A');
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });

  it('切换对象后：旧对象的请求不再算当前（即使它最后返回）', () => {
    const g = createSeqGuard();
    const forA = g.begin('usr_A');
    const forB = g.begin('usr_B');
    expect(g.isCurrent(forB)).toBe(true);
    // A 晚到 —— 必须被判过期，否则会覆盖 B
    expect(g.isCurrent(forA)).toBe(false);
  });

  it('业务键相同但序号过期时也不算当前（重试场景）', () => {
    const g = createSeqGuard();
    const first = g.begin('usr_X');
    g.begin('usr_X');
    expect(g.isCurrent(first)).toBe(false);
  });

  it('传 null/undefined 时安全返回 false', () => {
    const g = createSeqGuard();
    g.begin('k');
    expect(g.isCurrent(null)).toBe(false);
    expect(g.isCurrent(undefined)).toBe(false);
  });

  it('current() 暴露递增序号（便于日志/调试）', () => {
    const g = createSeqGuard();
    expect(g.current()).toBe(0);
    g.begin('a'); g.begin('b');
    expect(g.current()).toBe(2);
  });
});


// ── 接线护栏（2026-11-02）──
// 纯函数测试只能证明守卫本身对；不能证明 UserDialog 真的用了它。
// 这里读源码断言接线仍在：否则有人「重构」掉 isCurrent 判据，纯函数测试依然全绿。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dialogSrc = readFileSync(path.join(here, '..', 'components', 'UserDialog.vue'), 'utf8');

describe('UserDialog 接线（防「逻辑写了但没接上」）', () => {
  it('loadProfile 用 guard 丢弃过期响应', () => {
    expect(dialogSrc).toMatch(/profileGuard\.begin\(user\.value\.userId\)/);
    expect(dialogSrc).toMatch(/if \(!profileGuard\.isCurrent\(rec\)/);
  });
  it('loadEvents 同样有判据', () => {
    expect(dialogSrc).toMatch(/eventsGuard\.begin\(user\.value\.userId\)/);
    expect(dialogSrc).toMatch(/!eventsGuard\.isCurrent\(rec\)/);
  });
  it('loading 只由最新一次请求收尾', () => {
    expect(dialogSrc).toMatch(/if \(profileGuard\.isCurrent\(rec\)\) loading\.value = false/);
  });
});


// ── 未定义标识符护栏（2026-11-02 生产事故后补）──
// 事故：UserDialog 调用了 createSeqGuard()，但 import 语句**从未被插入**
// （我的插入脚本用「文件里有没有 seq-guard 字样」做幂等判断，而刚写的注释里正好含这个词
//   ⇒ 条件恒假 ⇒ import 被跳过）。页面上线后整块报「createSeqGuard is not defined」。
// 当时的测试只断言源码里有 createSeqGuard 字面量 ⇒ 全绿。**测的是文本，不是可执行性**。
//
// 这条护栏改判据：对 import 进来的每个名字，若在文件里被「调用」却**没有任何 import/声明** ⇒ 红。
const dialogImports = [...dialogSrc.matchAll(/import\s*\{([^}]*)\}\s*from/g)]
  .flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop().trim()))
  .filter(Boolean);
const importedOrDeclared = new Set(dialogImports);
for (const m of dialogSrc.matchAll(/(?:const|let|var|function)\s+([a-zA-Z_$][\w$]*)/g)) importedOrDeclared.add(m[1]);
for (const m of dialogSrc.matchAll(/const\s*\{([^}]*)\}\s*=/g)) {
  for (const part of m[1].split(',')) {
    const t = part.trim().replace(/:.*$/, '').trim();
    if (/^[a-zA-Z_$][\w$]*$/.test(t)) importedOrDeclared.add(t);
  }
}

describe('UserDialog 不得调用未定义的标识符（生产事故回归）', () => {
  it('createSeqGuard 必须真的被 import', () => {
    expect(importedOrDeclared.has('createSeqGuard'), '缺少 import 会导致页面整块报错').toBe(true);
  });

  it('模板/脚本里出现的自定义调用都在已定义集合内', () => {
    const CALL = /\b([a-z][a-zA-Z0-9_$]{4,})\s*\(/g;
    const BUILTIN = new Set(['function','return','typeof','catch','switch','parseInt','parseFloat','isNaN','setTimeout','clearTimeout','encodeURIComponent','decodeURIComponent','JSON','Object','Array','Number','String','Boolean','Math','Date','Promise','require','fetch','console','undefined','if','for','while']);
    const missing = new Set();
    // 只扫脚本区（<style> 里的 translateY/repeat/minmax 是 CSS 函数，不是 JS 标识符）
    const scriptOnly = (dialogSrc.match(/<script setup>([\s\S]*?)<\/script>/) || [, ''])[1];
    for (const m of scriptOnly.matchAll(CALL)) {
      const name = m[1];
      if (BUILTIN.has(name)) continue;
      if (importedOrDeclared.has(name)) continue;
      // 方法调用（x.foo()）不算：看前一个非空白字符是否 .
      const before = scriptOnly.slice(Math.max(0, m.index - 1), m.index);
      if (before === '.') continue;
      missing.add(name);
    }
    expect([...missing], '这些标识符被调用但既没 import 也没声明: ' + [...missing].join(', ')).toEqual([]);
  });
});
