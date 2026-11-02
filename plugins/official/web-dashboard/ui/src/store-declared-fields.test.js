// @vitest-environment happy-dom
/**
 * store-declared-fields.test.js —— reactive 对象必须预先声明所有会被写入的字段（2026-11-02）
 *
 * 为什么立这条：Vue 3 的 reactive() 基于 Proxy，给未声明的新属性赋值不会触发依赖更新
 * （等价于 Vue 2 的 set 问题）。本仓 store.js 里 loadError 长期只在各处「赋值」，
 * 而 reactive 初始对象里没有它 —— 动态页「加载失败」横幅可能因此不刷新。
 *
 * 本用例扫 store.js 源码：找出所有被 store.x = ... 写入的字段，
 * 断言它们都出现在 reactive 初始声明里。新增字段忘了声明就会红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, 'store.js'), 'utf8');

const start = src.indexOf('export const store = reactive({');
const end = src.indexOf(String.fromCharCode(10) + '});', start);
const block = src.slice(start, end);

const declared = new Set();
for (const m of block.matchAll(/^\s{2}([a-zA-Z_$][\w$]*)\s*:/gm)) declared.add(m[1]);

const assigned = new Set();
for (const m of src.matchAll(/store\.([a-zA-Z_$][\w$]*)\s*(=[^=]|\+\+|\+=)/g)) assigned.add(m[1]);

describe('store 响应式字段声明', () => {
  it('reactive 初始块能被解析到（防止用例因重构静默失效）', () => {
    expect(start).toBeGreaterThan(0);
    expect(declared.size).toBeGreaterThan(20);
  });

  it('每个被赋值的 store 字段都已预先声明', () => {
    const missing = [...assigned].filter((k) => !declared.has(k));
    expect(missing, '未声明却被赋值（Vue 3 下不会触发更新）: ' + missing.join(', ')).toEqual([]);
  });

  it('loadError 必须有声明（本次修复的具体字段）', () => {
    expect(declared.has('loadError')).toBe(true);
  });
});