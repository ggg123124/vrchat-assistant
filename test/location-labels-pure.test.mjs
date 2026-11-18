// 位置标签纯函数的行为断言（审查方 #250 建议：源码正则钉不住「能不能跑」与主行为）
// 直接 import 生产用的 utils.js；把主行为改回旧写法就一定变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { specialLocationLabel, prevLocationLabel, isPrivateInstance, parseLoc, locLabelFull, instanceLabel } from '../plugins/official/web-dashboard/ui/src/utils.js';

test('纯值形态：private 必须给「私人房间」', () => {
  assert.equal(specialLocationLabel('private'), '私人房间');
});

test('实例串形态：~private(usr_x) 也必须给「私人房间」', () => {
  const loc = 'wrld_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:12345~private(usr_1111)';
  assert.equal(parseLoc(loc).type, 'private', '前置：parseLoc 必须把它判成 private');
  assert.equal(specialLocationLabel(loc), '私人房间');
});

test('公开实例不得被改写（返回空，交给调用方回退世界名）', () => {
  const loc = 'wrld_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:12345~region(us)';
  assert.equal(parseLoc(loc).type, 'public');
  assert.equal(specialLocationLabel(loc), '');
});

test('其余纯值形态也要给人话', () => {
  assert.equal(specialLocationLabel('offline'), '离线');
  assert.equal(specialLocationLabel('offline:offline'), '网页在线');
  assert.equal(specialLocationLabel('traveling'), '传送中');
  assert.equal(specialLocationLabel('local'), '本地房间');
});

test('locLabelFull 拼出「公开 · US · 12345」', () => {
  const loc = 'wrld_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:12345~region(us)';
  assert.equal(locLabelFull(loc), instanceLabel('public') + ' · US · 12345');
  assert.match(locLabelFull(loc), /^公开 · US · 12345$/);
});

test('空/无类型输入不得抛错', () => {
  assert.equal(specialLocationLabel(''), '');
  assert.equal(locLabelFull(''), '');
});

// 已知行为差异（不在本 PR 范围内，如实记录以免后来者以为是本 PR 的缺陷）：
//   locLabelFull('…~invite(usr_x)') / '…~private'（无 ownerId）时，parseLoc 判 type='public'
//   ⇒ specialLocationLabel 不返回「私人房间」。当前实现只对 parseLoc 判出 private/invite/invite+
//   的形态生效；这两种形态 parseLoc 不给那些 type，需要另案评估（改 parseLoc 影响面更大）。
test('traveling 变体：parseLoc 会剥前缀，但仍需上游归一才能拿到「传送中」标签', () => {
  // 2026-09-25 #261 回归用例：钉住「为何必须在 DTO 层把 traveling:traveling 归一为 traveling」。
  //
  // 2026-11-17 更新：parseLoc 现在会剥掉 traveling: 前缀（此前 'traveling:wrld_abc:1' 会把
  // 世界 ID 当成房间号，输出「公开 · wrld_abc:1」）。因此**不再**出现 type='public' 那类荒谬渲染；
  // 但 specialLocationLabel 仍只认归一后的纯值 'traveling' ⇒ **上游归一依然必要**，
  // 否则该好友的位置标签会是空串而不是「传送中」。
  assert.equal(specialLocationLabel('traveling'), '传送中');
  assert.equal(specialLocationLabel('traveling:traveling'), '', '变体不是特殊值 ⇒ 仍必须由上游归一');
  const v = parseLoc('traveling:traveling');
  assert.notEqual(v.type, 'public', '剥前缀后不得再被判成公开实例');
  assert.equal(v.worldId, 'traveling', '剥前缀后剩下的是这个纯值自身');
  // 真正要保护的是「传送中目的地」能正确解析：
  assert.equal(parseLoc('traveling:wrld_abc:1').worldId, 'wrld_abc');
  assert.equal(parseLoc('traveling:wrld_abc:1').instanceId, '1');
  assert.equal(locLabelFull('traveling:wrld_abc:1'), '公开 · 1', '房间号不得把世界 ID 一起吃进去');
});

// ── 位置行左端「从哪来」（用户 2026-10-17 定）────────────────────────────────
// 上一刻是仅邀请/私人房间时，即使拿不到世界名也必须给「私人房间」，不许跳过它去显示更早的世界名。
const PRIVATE_LOC = 'wrld_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:12345~private(usr_1111)';
const INVITE_PLUS_LOC = 'wrld_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:12345~private(usr_1111)~canRequestInvite';
const PUBLIC_LOC = 'wrld_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:12345~region(us)';

test('左端：上一刻是仅邀请房间且拿不到世界名 ⇒ 「私人房间」（不得空白、也不得回退到更早的世界）', () => {
  assert.equal(parseLoc(PRIVATE_LOC).type, 'private', '前置：parseLoc 判 private');
  assert.equal(prevLocationLabel(PRIVATE_LOC, ''), '私人房间');
  assert.equal(prevLocationLabel(INVITE_PLUS_LOC, ''), '私人房间', 'private + canRequestInvite = invite+ 同属私人房间');
});

test('左端：上一刻是私人/仅邀请 ⇒ 一律「私人房间」（用户 2026-10-17 定案，不改写成世界名）', () => {
  // 刻意让实例类型优先于世界名：用户原话「上次是私人房间就私人房间」「如果他的家是仅邀请这种那就显示上线 私人房间」。
  // 这正是本次要防的退化——修「不得回退到更早的世界」时，别把它顺手改成「私人房也显示世界名」。
  assert.equal(prevLocationLabel(PRIVATE_LOC, '某私人世界'), '私人房间');
});

test('左端：公开实例拿得到世界名 ⇒ 显示世界名（2026-09-24 定案）', () => {
  assert.equal(prevLocationLabel(PUBLIC_LOC, '某公开世界'), '某公开世界');
});

test('左端：特殊值仍走人话（离线 / 传送中 / 网页在线）', () => {
  assert.equal(prevLocationLabel('offline', ''), '离线');
  assert.equal(prevLocationLabel('traveling', ''), '传送中');
  assert.equal(prevLocationLabel('offline:offline', ''), '网页在线');
});

test('左端：公开实例且无世界名 ⇒ 空（不编造「私人房间」）', () => {
  assert.equal(prevLocationLabel(PUBLIC_LOC, ''), '');
  assert.equal(prevLocationLabel('', ''), '');
  assert.equal(prevLocationLabel(undefined, undefined), '');
});

test('左端：未知纯值形态没有中文标签 ⇒ 返回空（前端据此隐藏整块左端，而不是编造文案）', () => {
  assert.equal(prevLocationLabel('mystery:weird', ''), '');
  assert.equal(prevLocationLabel('hidden', ''), '');
});

// isPrivateInstance：位置行左右两端共用的唯一判据（2026-10-18 复审 💡1 要求删掉恒假的 'invite' 分支）
test('isPrivateInstance：private 与 invite+ 命中，public / 特殊值 / 空不命中', () => {
  assert.equal(isPrivateInstance(PRIVATE_LOC), true, '~private(usr) 是私人房');
  assert.equal(isPrivateInstance(INVITE_PLUS_LOC), true, 'private + canRequestInvite = invite+，同属私人房');
  assert.equal(isPrivateInstance(PUBLIC_LOC), false, '公开实例不是私人房（否则左端会把它写成「私人房间」）');
  assert.equal(isPrivateInstance('offline'), false);
  assert.equal(isPrivateInstance('traveling'), false);
  assert.equal(isPrivateInstance(''), false);
  assert.equal(isPrivateInstance(undefined), false);
});

test('parseLoc 不会产出 type=invite ⇒ 判据里不得再写 p.type === "invite"（复审 💡1 的死分支）', () => {
  // 反面自检：真去构造一个 '~invite(usr)' 的实例串，parseLoc 给的仍是 public ——
  // 这正是「写 p.type === 'invite' 恒假」的根据；将来若 parseLoc 变了，这条会提示重新看判据。
  const odd = 'wrld_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:12345~invite(usr_1111)';
  assert.notEqual(parseLoc(odd).type, 'invite');
  assert.equal(isPrivateInstance(odd), false);
});
