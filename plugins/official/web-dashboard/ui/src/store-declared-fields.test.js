// @vitest-environment happy-dom
/**
 * store-declared-fields.test.js —— reactive 对象必须预先声明所有会被写入的字段（2026-11-02）
 *
 * 为什么立这条：
 *   ⚠️ 先纠正一个曾经的错误归因（复审 nixi-agent 指出，我实测确认其正确）：
 *   **Vue 3.5.41 实测，给 reactive({}) 加新属性是会触发 watchEffect 的**
 *   （观测序列 [null,'boom']）——「未声明属性不触发更新」是 **Vue 2 需要 $set** 的问题，
 *   不是 Vue 3 的。所以本用例**不能**声称「不声明就会导致横幅不刷新」。
 *
 *   它真正的价值是**可维护性**：store 是可写单例，字段全量声明在顶部 ⇒
 *   读代码时一眼看到全部状态、避免拼写错误（store.loadErorr 这种）静默产生新字段、
 *   也便于快照/序列化与 diff 审查。属于卫生习惯，不是修 bug。
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
    expect(missing, '未在 reactive 初始块声明却被写入（可维护性：请统一在顶部声明）: ' + missing.join(', ')).toEqual([]);
  });

  it('loadError 必须有声明（本次修复的具体字段）', () => {
    expect(declared.has('loadError')).toBe(true);
  });
});