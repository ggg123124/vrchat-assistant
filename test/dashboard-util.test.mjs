import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const base = 'plugins/official/web-dashboard/client/js/';
const utilJs = readFileSync(base + 'util.js', 'utf8');
const appJs = readFileSync(base + 'app.js', 'utf8');

// 从 app.js 提取 CONFUSABLES（util 里 flagName/confusableFlag 依赖它）
let confusables = {};
const m = appJs.match(/const CONFUSABLES=(\{[^]*?\};)/);
if (m) {
  try { confusables = Function('return ' + m[1].replace(/;\s*$/, ''))(); } catch { /* 提取失败则用空映射 */ }
}

// 加载 util.js 纯函数（Function 构造器内 const 成为局部，返回导出）
const F = new Function('CONFUSABLES', utilJs + '\n;return {esc,time,date,worldLabel,parseLoc,locLabel,statusCls,isWebOnline,statusDot,trustBadge,trustColor,eventType};');
const api = F(confusables);

test('信任等级颜色（VRCX presets 标准值）', () => {
  assert.match(api.trustBadge('Trusted User'), /tb-purple/, 'Trusted User → 紫');
  assert.match(api.trustBadge('Known User'), /tb-orange/, 'Known User → 橙');
  assert.match(api.trustBadge('New User'), /tb-blue/, 'New User → 蓝');
  assert.match(api.trustBadge('User'), /tb-green/, 'User → 绿');
  assert.match(api.trustBadge('Visitor'), /tb-gray/, 'Visitor → 灰');
  assert.match(api.trustBadge('VRChat Team'), /tb-red/, 'VRChat Team → 红');
  assert.equal(api.trustBadge(''), '', '空值返回空');
  assert.equal(api.trustBadge(null), '', 'null 返回空');
});

test('在线状态色（active/join me/ask me/busy/web）', () => {
  assert.equal(api.statusCls('active'), 's-active');
  assert.equal(api.statusCls('join me'), 's-joinme');
  assert.equal(api.statusCls('ask me'), 's-askme');
  assert.equal(api.statusCls('busy'), 's-busy');
  assert.equal(api.statusCls('web'), 's-web');
  assert.equal(api.statusCls('offline'), 's-offline');
  assert.equal(api.statusCls(''), '');
});

test('仅网页在线判定（platform=web 且在线）', () => {
  assert.equal(api.isWebOnline({ isOnline: 1, platform: 'web' }), true);
  assert.equal(api.isWebOnline({ isOnline: 1, platform: 'Web' }), true, '大小写不敏感');
  assert.equal(api.isWebOnline({ isOnline: 0, platform: 'web' }), false, '离线不算网页在线');
  assert.equal(api.isWebOnline({ isOnline: 1, platform: 'standalonewindows' }), false);
  assert.equal(api.isWebOnline({ isOnline: 1, platform: 'standalonewindows', location: 'offline' }), false, 'location=offline 是离线残留，非网页在线（对齐 VRCX）');
  assert.equal(api.isWebOnline({ isOnline: 1, platform: 'standalonewindows', worldId: 'private' }), false, '私人实例=游戏内，非网页在线（对齐 VRCX）');
  assert.equal(api.isWebOnline({ isOnline: 1, platform: 'standalonewindows', worldId: 'wrld_x' }), false, '桌面端在实例');
  assert.equal(api.isWebOnline({ isOnline: 1, platform: 'standalonewindows', worldId: 'traveling' }), false, '传送中');
  assert.equal(api.isWebOnline({ isOnline: 1, platform: 'android' }), false);
  assert.equal(api.isWebOnline({}), false);
});

test('世界名标签', () => {
  assert.equal(api.worldLabel({ worldName: '阿彌陀佛', worldId: 'wrld_x' }), '阿彌陀佛');
  assert.equal(api.worldLabel({ worldId: 'wrld_74636a47' }), '未知世界', '无名字不显示 id（对齐修复清单#4）');
  assert.equal(api.worldLabel({}), '未公开位置', '无 worldId 显示未公开位置');
});

test('实例位置解析', () => {
  // VRChat location 格式：worldId:instanceId
  assert.ok(api.locLabel('wrld_x:private')?.length > 0, 'private 实例有标签');
  assert.ok(api.locLabel('wrld_x:12345')?.length > 0, '公开实例有标签');
  assert.equal(api.locLabel(''), '', '空位置返回空');
});

test('实例类型解析：friends+（回归：2026-08-30 修复 ~friends+ 被误标 public）', () => {
  // ~friends+(usr) 是 friends+（好友+）——旧正则缺 friends\+ 会误匹配为 public
  const p = api.parseLoc('wrld_x:12345~friends+(usr_abc)~region(usw)');
  assert.equal(p.type, 'friends+', '~friends+(usr) 应解析为 friends+');
  assert.equal(p.ownerId, 'usr_abc');
  // 其余类型不受影响（parseLoc 返回原始 token；显示层 instanceLabel 再映射为中文）
  assert.equal(api.parseLoc('wrld_x:1~private(usr_a)').type, 'private', '~private 原始 token');
  assert.equal(api.parseLoc('wrld_x:1~hidden(usr_a)').type, 'hidden', '~hidden 原始 token');
  assert.equal(api.parseLoc('wrld_x:1~friends(usr_a)').type, 'friends', '~friends 原始 token');
  assert.equal(api.parseLoc('wrld_x:1').type, 'public', '无 token 应解析为公开');
  // invite+（~canRequestInvite）语义不受影响
  assert.equal(api.parseLoc('wrld_x:1~private(usr_a)~canRequestInvite').type, 'invite+', '~canRequestInvite → invite+');
});

test('HTML 转义', () => {
  assert.equal(api.esc('<b>&"'), '&lt;b&gt;&amp;&quot;');
  assert.equal(api.esc('plain'), 'plain');
});

test('事件类型 class', () => {
  assert.equal(api.eventType('friend-online'), 'online');
  assert.equal(api.eventType('friend-offline'), 'offline');
  assert.equal(api.eventType('friend-update'), 'update');
});


test('实例位置标签（legacy locLabel：hidden→Friends+ / friends→Friends）', () => {
  assert.equal(api.locLabel('wrld_x:1~hidden(usr_a)'), 'Friends+', '~hidden → Friends+');
  assert.equal(api.locLabel('wrld_x:1~friends(usr_a)'), 'Friends', '~friends → Friends');
  assert.equal(api.locLabel('wrld_x:1'), 'Public', '公开实例 → Public');
  assert.equal(api.locLabel('wrld_x:1~private(usr_a)'), 'Private', '~private → Private');
  assert.equal(api.locLabel(''), '', '空位置返回空');
});
