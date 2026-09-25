// `.uicon` CSS 规则作用域的源码级回归护栏（2026-09-25 建）
//
// 为什么需要它：FeedView.vue 里 `.world-link { … }` 只要少一个闭合 `}`，紧随其后的
//   `.uicon { width: 26px; … }` 就会被 CSS 解析成 `.world-link .uicon`（后代选择器）
//   ⇒ 事件行里的头像**不受 26px 约束、按原始尺寸撑开**（用户报障的「头像突然变成大图」）。
//   ⚠️ 这个形态在 24 小时内复发过 3 次，而**「花括号配平」不能当判据** ——
//   少一个 + 别处多一个会互相抵消，两边都是 390/390 照样通过（实测）。
//
// 判据（比配平可靠）：`.uicon` 的规则行必须**不在** `.world-link` 的 `{ … }` 区间内。
// 被覆盖时（规则被搬回块内、或整块被重写成嵌套形态）npm test 直接变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, '..', 'plugins', 'official', 'web-dashboard', 'ui', 'src');
const feed = readFileSync(path.join(UI, 'views', 'FeedView.vue'), 'utf8');
const lines = feed.split('\n');

/** 返回「以 selector 开头的那条规则」的 [开始行, 闭合行]（0 基）；找不到返回 null。 */
function ruleRange(selector) {
  const start = lines.findIndex((l) => l.startsWith(selector));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== '}') end += 1;
  return [start, end];
}

test('`.uicon` 规则是顶层规则，没有被 `.world-link` 吞成后代选择器', () => {
  const wl = ruleRange('.world-link {');
  const ui = ruleRange('.uicon {');

  assert.ok(wl, 'FeedView.vue 里应当存在 .world-link 规则（找不到说明模板被大改，需人工确认）');
  assert.ok(ui, 'FeedView.vue 里应当存在 .uicon 规则（事件行头像的 26px 约束靠它）');

  const [wlStart, wlEnd] = wl;
  const [uiStart] = ui;

  assert.ok(
    uiStart > wlEnd,
    [
      '`.uicon` 规则被 `.world-link` 的块包住了（CSS 会把它解析成后代选择器）：',
      `  .world-link { 在第 ${wlStart + 1} 行，闭合 } 在第 ${wlEnd + 1} 行`,
      `  但 .uicon { 在第 ${uiStart + 1} 行 —— 落在该区间内`,
      '  修法：把 `.uicon { … }` 那一行整体移到 `.world-link` 的闭合 `}` 之后（不要靠补 `}` —— 配平是假判据）。',
    ].join('\n'),
  );
});

test('`.uicon` 规则保留 26px 尺寸约束（防误删）', () => {
  const ui = ruleRange('.uicon {');
  assert.ok(ui, '.uicon 规则必须存在');
  const rule = lines[ui[0]];
  assert.match(rule, /width:\s*26px/);
  assert.match(rule, /height:\s*26px/);
  assert.match(rule, /object-fit:\s*cover/);
});
