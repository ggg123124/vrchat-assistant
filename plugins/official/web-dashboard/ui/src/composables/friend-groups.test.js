// @vitest-environment happy-dom
/**
 * friend-groups.test.js —— 侧栏世界分组的标题与位置标签（2026-11-17）
 *
 * 用户报障：动态流里能看到世界名，侧栏同一个人却显示「未公开位置」。
 *
 * 查证（含对照 VRCX 的实现）确认两个独立缺陷：
 *  1) 组标题只看 l[0].worldName —— 同一世界里排第一的人缓存没回填，整组就掉 fallback；
 *  2) fallback 在「有 worldId 但没名字」时也输出「未公开位置」，而 VRCX 的
 *     getLocationText 对此直接显示 worldId（name = worldName || L.worldId）。
 *
 * 本用例钉住：
 *  - 组内任一人有名字 ⇒ 用该名字（不再看位置顺序）
 *  - 有 worldId 而无名字 ⇒ 标题是世界 ID，不是任何「未知/未公开」字样
 *  - private ⇒ 私密实例
 *  - 有 worldId 时位置标签（房间号·实例类型·区域）必须展示，与有无名字解耦
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isWebOnline } from '../utils.js';

const mountGroups = async () => {
  vi.resetModules();
  const storeMod = await import('../store.js');
  const { useFriendGroups } = await import('./useFriendGroups.js');
  return { storeMod, g: useFriendGroups() };
};

const F = (o) => ({
  userId: 'usr_' + Math.random().toString(36).slice(2),
  displayName: 'F', isOnline: true, platform: 'standalonewindows',
  location: '', worldId: '', worldName: '', ...o,
});

describe('侧栏世界分组：标题与位置标签', () => {
  let ctx;
  beforeEach(async () => { ctx = await mountGroups(); });

  it('组内任一人有世界名就用它（不看是谁排第一）', () => {
    const wid = 'wrld_28d32731-dfc5-4ca1-a773-570037819e0b';
    const list = [
      F({ worldId: wid, worldName: '', location: wid + ':45176~hidden(usr_x)' }),
      F({ worldId: wid, worldName: '水底 -Seabed-', location: wid + ':45176~hidden(usr_x)' }),
    ];
    const gs = ctx.g.groupByWorld(list);
    expect(gs.length).toBe(1);
    expect(gs[0].label, '不能因为第一个人没名字就丢掉整组的名字').toBe('水底 -Seabed-');
    expect(gs[0].nameUnavailable).toBe(false);
  });

  it('有 worldId 但组内无人知道名字 ⇒ 标题是世界 ID，不是「未公开位置」', () => {
    const wid = 'wrld_28d32731-dfc5-4ca1-a773-570037819e0b';
    const gs = ctx.g.groupByWorld([F({ worldId: wid, worldName: '', location: wid + ':45176~hidden(usr_x)' })]);
    expect(gs[0].label).toBe(wid);
    expect(gs[0].nameUnavailable, '视图可据此提示名字待补').toBe(true);
    expect(gs[0].label).not.toMatch(/未公开|未知/);
  });

  it('private ⇒ 私密实例', () => {
    const gs = ctx.g.groupByWorld([F({ worldId: 'private', worldName: '', location: 'private', platform: 'standalonewindows' })]);
    expect(gs[0].label).toBe('私密实例');
  });

  it('有 worldId 时位置标签必须展示（与有无名字解耦）', () => {
    const wid = 'wrld_28d32731-dfc5-4ca1-a773-570037819e0b';
    const gs = ctx.g.groupByWorld([F({ worldId: wid, worldName: '', location: wid + ':45176~hidden(usr_x)~region(jp)' })]);
    expect(gs[0].loc, '名字查不到不等于位置拿不到').toBeTruthy();
    expect(gs[0].loc).toContain('45176');
  });

  it('location 空的在线好友不再掉进「未公开位置」组（应归网页端在线）', () => {
    const gs = ctx.g.groupByWorld([
      F({ platform: '', location: '', worldId: '', worldName: '' }),
      F({ platform: 'web', location: 'offline', worldId: '', worldName: '' }),
    ]);
    const labels = gs.map((x) => x.label);
    expect(labels).toContain('网页端在线');
    expect(labels.some((l) => /未公开/.test(l)), '这个词不该再出现在界面上').toBe(false);
  });


describe('复审 2026-11-17：分组标题的兜底不该与 isWebOnline 打架', () => {
  let ctx;
  beforeEach(async () => { ctx = await mountGroups(); });

  // 复审 Lian-Hu 🔴1 / EMeowAGENT 🔴1：wid === 'none' 桶的老人不能叫「网页端在线」
  it('游戏端在线但 location 丢失 ⇒ 分组标题是「位置未知」，不是「网页端在线」', () => {
    const gs = ctx.g.groupByWorld([
      F({ platform: 'standalonewindows', location: '', worldId: '', worldName: '' }),
    ]);
    expect(gs.length).toBe(1);
    expect(gs[0].label).toBe('位置未知');
    // 与 isWebOnline 的判据保持一致（同一个人在 isWebOnline 里是 false）
    expect(isWebOnline({ isOnline: true, platform: 'standalonewindows', location: '' })).toBe(false);
  });

  it('不会与真正的网页在线组撞名（两个分组标题必须不同）', () => {
    const gs = ctx.g.groupByWorld([
      F({ platform: 'standalonewindows', location: '', worldId: '', worldName: '' }),
      F({ platform: 'web', location: 'offline', worldId: '', worldName: '' }),
    ]);
    const labels = gs.map((g) => g.label);
    expect(labels.length, '应有两个分组').toBe(2);
    expect(new Set(labels).size, '标题不得重复: ' + labels.join(',')).toBe(2);
    expect(labels).toContain('位置未知');
    expect(labels).toContain('网页端在线');
  });

  // 复审 EMeowAGENT ⚠️1：特殊纯值不能被当成世界 ID 上屏（英文裸值）
  it('worldId = traveling / offline 等特殊纯值 ⇒ 走中文标签，不显示英文裸值', () => {
    const a = ctx.g.groupByWorld([F({ worldId: 'traveling', location: 'traveling', worldName: '', platform: 'standalonewindows' })]);
    expect(a[0].label, 'traveling 应显示「传送中」').toBe('传送中');
    expect(a[0].label).not.toBe('traveling');

    // 复审 EMeowAGENT WARN2: offline 桶里 isOnline=true（刚登录/在菜单，位置字段丢了），
    // 所以组标题不能写「离线」——行文案会写「在线」，自相矛盾。
    const b = ctx.g.groupByWorld([F({ worldId: 'offline', location: 'offline', worldName: '', platform: 'standalonewindows' })]);
    expect(b[0].label).toBe('位置未知');
    expect(b[0].label).not.toBe('offline');
  });

  it('nameUnavailable 只在「真实 worldId 但没名字」时为 true（供组头提示）', () => {
    const wid = 'wrld_28d32731-dfc5-4ca1-a773-570037819e0b';
    const named = ctx.g.groupByWorld([F({ worldId: wid, worldName: '水底', location: wid + ':1' })]);
    expect(named[0].nameUnavailable).toBe(false);

    const unnamed = ctx.g.groupByWorld([F({ worldId: wid, worldName: '', location: wid + ':1' })]);
    expect(unnamed[0].nameUnavailable, '真实世界缺名字 ⇒ 提示待补').toBe(true);

    const special = ctx.g.groupByWorld([F({ worldId: 'private', worldName: '', location: 'private' })]);
    expect(special[0].nameUnavailable, '私密实例不是「名字待补」').toBe(false);
  });

  // 复审 EMeowAGENT 💡1：位置标签取源不能因为 namedOne 的 location 是过期 offline 就丢失
  it('组内有人带完整实例串时，loc 必须取到（即使有名字那人的 location 已过期）', () => {
    const wid = 'wrld_28d32731-dfc5-4ca1-a773-570037819e0b';
    const gs = ctx.g.groupByWorld([
      F({ worldId: wid, worldName: '水底 -Seabed-', location: 'offline' }),  // 有名字但位置过期
      F({ worldId: wid, worldName: '', location: wid + ':45176~hidden(usr_x)~region(jp)' }),
    ]);
    expect(gs[0].loc, '名字查不到 ≠ 位置拿不到；位置过期也不该让整组没位置').toBeTruthy();
    expect(gs[0].loc).toContain('45176');
  });
});



describe('复审 EMeowAGENT 第 3 轮：offline 桶与 instanceKeyOf', () => {
  let ctx;
  beforeEach(async () => { ctx = await mountGroups(); });

  // ⚠️2：offline 桶里 isOnline=true（刚登录/在菜单），组标题不能写「离线」
  it('worldId=offline 的桶标题不是「离线」（桶里人在线）', () => {
    const gs = ctx.g.groupByWorld([F({ worldId: 'offline', location: 'offline', worldName: '', platform: 'standalonewindows' })]);
    expect(gs[0].label).toBe('位置未知');
    expect(gs[0].label).not.toBe('离线');
  });

  it('worldId=offline:offline 的桶标题也不是「离线」/ 不与真网页组撞名', () => {
    const gs = ctx.g.groupByWorld([
      F({ worldId: 'offline:offline', location: 'offline:offline', worldName: '', platform: 'standalonewindows' }),
      F({ worldId: 'none', location: 'offline', worldName: '', platform: 'web', isOnline: true }),
    ]);
    const labels = gs.map((g) => g.label);
    // 两个桶都可能叫「位置未知」或「网页端在线」，关键是**不允许出现「离线」**
    expect(labels).not.toContain('离线');
  });

  // 💡：instanceKeyOf 必须复用 parseLoc，否则 traveling 与已到达会被算成两间房
  it('traveling 与已到达同一实例 => 只算 1 个房间（不误报「2 房间」）', () => {
    const wid = 'wrld_abc';
    const gs = ctx.g.groupByWorld([
      F({ worldId: wid, worldName: '水底', location: 'traveling:' + wid + ':1' }),
      F({ worldId: wid, worldName: '水底', location: wid + ':1' }),
    ]);
    expect(gs[0].roomCount, '同一实例不该被算成两间').toBe(1);
    expect(gs[0].mixedRooms).toBe(false);
  });

  it('同号不同 region 仍算两间（修饰段必须保留）', () => {
    const wid = 'wrld_abc';
    const gs = ctx.g.groupByWorld([
      F({ worldId: wid, worldName: '水底', location: wid + ':1~region(jp)' }),
      F({ worldId: wid, worldName: '水底', location: wid + ':1~region(us)' }),
    ]);
    expect(gs[0].roomCount).toBe(2);
    expect(gs[0].mixedRooms).toBe(true);
  });
});

});
