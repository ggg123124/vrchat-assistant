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
});