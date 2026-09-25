// 位置行 UI 行为的源码级回归护栏（2026-09-24 建）
//
// 为什么需要它：这段渲染逻辑在 2026-09-22 一天内被改了 3 次（1fdce1f → 3a2b30c → 上游合并），
// 每一次重写模板都会静默丢掉前一次接好的调用 —— 用户看到的现象是「明明修过又坏了」，
// 而当时没有任何测试能发现。这两条断言把"必须存在的行为"钉住，被覆盖时 npm test 直接变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, '..', 'plugins', 'official', 'web-dashboard', 'ui', 'src');
const feed = readFileSync(path.join(UI, 'views', 'FeedView.vue'), 'utf8');
const utils = readFileSync(path.join(UI, 'utils.js'), 'utf8');

test('位置行必须调用 specialLocationLabel —— 私人房/特殊值的「人话」兜底（用户 2026-09-22 定案）', () => {
  assert.match(feed, /specialLocationLabel\s*\(/, 'FeedView 必须调用 specialLocationLabel（否则「私人房间 / 离线 / 本地房间」等兜底不会显示）');
});

test('specialLocationLabel 必须按解析结果判断，不得只做整串相等', () => {
  assert.match(utils, /parseLoc\(/, 'specialLocationLabel 必须用 parseLoc 判断实例类型（真实位置形如 wrld_xxx:12345~private(usr_xxx)，整串相等永远不命中）');
  assert.match(utils, /私人房间/, '必须保留「私人房间」文案');
});

test('到达行不得挂「传送中」尾巴（用户 2026-09-22 定案：传送中只作独立行）', () => {
  assert.doesNotMatch(feed, /travelingToLocation/, '不得在位置事件里再挂传送中尾巴');
});

test('纯值形态的 private 也必须给「私人房间」（2026-09-22 那天修的形态，不能被后来的改动吃掉）', () => {
  assert.match(utils, /private:\s*['"]私人房间['"]/, 'direct 映射里的 private → 私人房间 必须保留');
});

test('位置行左端必须走 prevLabelOf（私人房 → 私人房间 那一半，用户 2026-09-22 定案）', () => {
  assert.match(feed, /function prevLabelOf\(/, 'FeedView 必须定义 prevLabelOf');
  assert.match(feed, /prevLabelOf\(x\)/, 'FeedView 模板必须使用 prevLabelOf');
  assert.match(feed, /function curIsWorld\(/, 'FeedView 必须定义 curIsWorld');
  assert.match(feed, /specialLocationLabel\(e\.previousLocation\)/, 'prevLabelOf 必须对 previousLocation 走 specialLocationLabel');
});

test('位置行左端必须渲染【图 + 世界名 + 实例信息】—— 不得按目的地类型把左端降级成纯文本（2026-09-24 用户定案「公开房间那侧要显示图像世界名和房间号」）', () => {
  assert.match(feed, /function prevInstLabel\(/, '必须定义 prevInstLabel');
  assert.match(feed, /\{\{\s*prevInstLabel\(x\)\s*\}\}/, '模板里必须真的把 prevInstLabel(x) 插值渲染出来（匹配函数定义不算）');
  assert.doesNotMatch(feed, /previousWorldImageUrl && curIsWorld/, '左端图片不得受 curIsWorld 限制（目的地是私人房时会整块不渲染）');
  assert.doesNotMatch(feed, /previousWorldId && curIsWorld/, '左端链接不得受 curIsWorld 限制');
});
