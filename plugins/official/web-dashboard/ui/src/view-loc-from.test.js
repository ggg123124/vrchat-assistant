// @vitest-environment happy-dom
/**
 * view-loc-from.test.js —— 视图层必须用 locFrom 打开房间（2026-11-17）
 *
 * 起因：`locFrom` 的不变式在 composable 层有测试，但**视图层没有护栏** ——
 * 把 `FriendsView` 或 `RightBar` 的 `openInstance(g.locFrom || …)` 改回 `g.list[0].location`，
 * 186 条测试会全绿，而用户点开的是**另一间房**（审核方 EMeowAGENT 第 6 轮 💡 指出）。
 *
 * 本仓已有源码级护栏先例（seq-guard.test.js 读 UserDialog.vue、
 * template-bindings.test.js 扫 .vue），这里沿用同一手法。
 *
 * 判据：
 *   1. `.fg-loc`（好友页）与 `.wg-loc`（侧栏）的 openInstance 实参必须含 locFrom
 *   2. 反向断言：两个视图都必须真的找到该 chip（防选择器改名后静默通过）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const FRIENDS = readFileSync(path.join(SRC, 'views/FriendsView.vue'), 'utf8');
const RIGHTBAR = readFileSync(path.join(SRC, 'components/RightBar.vue'), 'utf8');

/** 取出带指定 class 的元素标签（引号配对，属性值里的 > 不截断） */
function tagsWithClass(src, cls) {
  const out = [];
  const re = new RegExp('class="[^"]*\\b' + cls + '\\b[^"]*"');
  let i = 0;
  while ((i = src.indexOf('<', i)) !== -1) {
    let j = i + 1;
    let q = null;
    while (j < src.length) {
      const c = src[j];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
      j++;
    }
    const tag = src.slice(i, j + 1);
    if (re.test(tag)) out.push(tag);
    i = j + 1;
  }
  return out;
}

describe('视图层 locFrom 收口', () => {
  it('好友页 .fg-loc 的 openInstance 实参必须含 locFrom', () => {
    const tags = tagsWithClass(FRIENDS, 'fg-loc');
    expect(tags.length, '找不到 .fg-loc ⇒ 选择器可能已改名，判据失效').toBeGreaterThan(0);
    // 只检查「组上下文」的 chip（实参用 g.xxx）；另两处 .fg-loc 是「我自己所在房间」，
    // 直接用 store.me.location，不存在「显示与点击不同源」的问题。
    const clickable = tags.filter((t) => t.includes('openInstance') && /openInstance\(g\./.test(t));
    expect(clickable.length, '.fg-loc 里没有组上下文的 openInstance 调用').toBeGreaterThan(0);
    const bad = clickable.filter((t) => !t.includes('locFrom'));
    expect(bad.map((t) => t.replace(/\s+/g, ' ').slice(0, 90)),
      '好友页会点开「另一间房」（显示用 locSource、点击用 list[0]）').toEqual([]);
  });

  it('侧栏 .wg-loc 的 openInstance 实参必须含 locFrom', () => {
    const tags = tagsWithClass(RIGHTBAR, 'wg-loc');
    expect(tags.length, '找不到 .wg-loc ⇒ 判据失效').toBeGreaterThan(0);
    const clickable = tags.filter((t) => t.includes('openInstance'));
    expect(clickable.length).toBeGreaterThan(0);
    const bad = clickable.filter((t) => !t.includes('locFrom'));
    expect(bad.map((t) => t.replace(/\s+/g, ' ').slice(0, 90)), '侧栏会点开「另一间房」').toEqual([]);
  });
});