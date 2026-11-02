// @vitest-environment happy-dom
/**
 * clickable-binding-shape.test.js —— v-clickable 必须绑「函数」而不是「表达式」（2026-11-02 事故）
 *
 * 事故：48 处写成 `v-clickable="fn(x)"`。Vue 会**渲染期立即求值**该表达式：
 *   ① 有副作用的 fn（toggleRow 改 ref / openWorld 开弹窗）⇒ 渲染 → 改状态 → 重渲染 → 死循环 → OOM；
 *   ② 返回值通常是 undefined ⇒ 指令里 normalize() 判非函数 ⇒ 一个监听都没挂上（可点元素全失效）。
 *
 * 当时 138 条用例全绿，因为那些用例都是「直接给指令传函数」，从没测过真实模板绑定形态。
 * 本用例改判据：扫所有 .vue 的 v-clickable 属性值，必须是箭头函数 / 函数引用，
 * 不得是「调用表达式」（含 `(` 且不以 `(` 开头）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name !== 'node_modules') walk(p, out); }
    else if (name.endsWith('.vue')) out.push(p);
  }
  return out;
}

const vueFiles = walk(SRC);
const bindings = [];
for (const f of vueFiles) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/v-clickable(?:\.stop|\.prevent)?="([^"]*)"/g)) {
    bindings.push({ file: path.relative(SRC, f), expr: m[1].trim() });
  }
}

describe('v-clickable 绑定形态', () => {
  it('至少扫到 40 处绑定（防止用例因重构静默失效）', () => {
    expect(bindings.length).toBeGreaterThan(40);
  });

  it('每一处都必须是惰性函数（箭头/函数引用），不得是调用表达式', () => {
    const bad = bindings.filter(({ expr }) => {
      // 合法： (e) => (...)  /  () => ...  /  纯标识符（函数引用）
      if (/^\([^)]*\)\s*=>/.test(expr)) return false;
      if (/^[A-Za-z_$][\w$]*$/.test(expr)) return false;
      return true;
    });
    expect(
      bad.map((b) => b.file + ' → v-clickable="' + b.expr + '"'),
      '这些绑定会在渲染期执行（副作用 ⇒ 死循环 / 监听挂不上）'
    ).toEqual([]);
  });
});