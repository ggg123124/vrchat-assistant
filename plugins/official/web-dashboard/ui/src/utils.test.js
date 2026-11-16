// utils 纯函数单测（重构行为等价锚点）
import { describe, it, expect } from 'vitest';
import { time, date, reltime, parseTs, parseLoc, avatarLabel, isWebOnline, platformLabel, platformIcon, dateTime } from './utils.js';

describe('时间格式', () => {
  it('time/date 空值兜底', () => {
    expect(time('')).toBe('--:--');
    expect(date('')).toBe('--/--');
  });
  it('reltime 分级', () => {
    expect(reltime('')).toBe('');
    expect(reltime('not-a-date')).toBe('');
    expect(reltime(Date.now())).toBe('刚刚');
    expect(reltime(Date.now() - 5 * 60_000)).toBe('5 分钟前');
    expect(reltime(Date.now() - 3 * 3_600_000)).toBe('3 小时前');
    expect(reltime(Date.now() - 2 * 86_400_000)).toBe('2 天前');
  });
  it('dateTime 完整', () => {
    const r = dateTime('2026-08-31T06:00:00Z');
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });
  it('SQLite 无时区串按 UTC 解析（修复 UTC+8 偏移 8h bug）', () => {
    // datetime('now') 产出 "YYYY-MM-DD HH:MM:SS"（UTC，无时区标记）
    // 旧实现 new Date('2026-09-01 08:47:50') 在 UTC+8 设备被当本地时间，偏移 8h
    const sqlite = '2026-09-01 08:47:50';
    const iso = '2026-09-01T08:47:50.000Z'; // 同一时刻的 ISO
    expect(parseTs(sqlite).getTime()).toBe(new Date(iso).getTime());
    expect(parseTs('2026-09-01T08:47:50.000Z').getTime()).toBe(new Date(iso).getTime()); // ISO 原样
    expect(parseTs('2026-09-01 08:47:50.123').getTime()).toBe(new Date('2026-09-01T08:47:50.123Z').getTime()); // 小数秒
    expect(parseTs('2026-09-01 08:47:50Z').getTime()).toBe(new Date(iso).getTime()); // 空格+Z 形态也按 UTC
    expect(Number.isNaN(parseTs('not-a-date').getTime())).toBe(true);
    expect(Number.isNaN(parseTs('').getTime())).toBe(true);
    expect(Number.isNaN(parseTs(null).getTime())).toBe(true);
    expect(parseTs(1725000000000).getTime()).toBe(1725000000000); // 数字时间戳原样
  });
});


describe('位置解析', () => {
  it('特殊值不误解析', () => {
    for (const v of ['offline', 'offline:offline', 'traveling']) {
      const r = parseLoc(v);
      expect(r.worldId).toBe(v);
      expect(r.instanceId).toBeNull();
      expect(r.type).toBeNull();
    }
  });
  it('标准实例格式（type 来自 ~ 标记）', () => {
    const r = parseLoc('wrld_123:abc~private(usr_abc)~region(us)');
    expect(r.worldId).toBe('wrld_123');
    expect(r.instanceId).toBe('abc');
    expect(r.type).toBe('private');
    expect(r.ownerId).toBe('usr_abc');
    expect(r.region).toBe('us');
  });
  it('无 ~ 标记时 type 默认 public', () => {
    const r = parseLoc('wrld_123:abc');
    expect(r.type).toBe('public');
  });
  it('空值', () => {
    expect(parseLoc('')).toBeNull();
    expect(parseLoc(null)).toBeNull();
  });
});

describe('头像/平台', () => {
  it('avatarLabel 无图时显示首字母', () => {
    expect(avatarLabel('', 'Alice')).toBe('A');
    expect(avatarLabel('', '')).toBe('?');
    expect(avatarLabel('http://img')).toBeUndefined();
  });
  it('isWebOnline 识别网页在线（对象）', () => {
    expect(isWebOnline({ isOnline: true, platform: 'web' })).toBe(true);
    expect(isWebOnline({ isOnline: true, platform: 'standalone' })).toBe(false);
    expect(isWebOnline({ isOnline: false, platform: 'web' })).toBe(false);
    expect(isWebOnline({ isOnline: true, location: 'offline:offline' })).toBe(true);
  });
  it('platformLabel/Icon 映射', () => {
    expect(platformLabel('standalone')).toBeTruthy();
    expect(platformIcon('web')).toBe('pi-globe');
    expect(platformIcon('standalone')).toBeTruthy();
    expect(platformIcon('')).toBe('');
  });


// ── 2026-11-17：参照 VRCX 的 isRealInstance 判据修正两处（用户报「侧栏显示未公开位置」）──
describe('isWebOnline 兜底（对齐 VRCX isRealInstance）', () => {
  const f = (o) => ({ isOnline: true, ...o });

  it('web 平台 / offline / offline:offline 仍判为网页在线', () => {
    expect(isWebOnline(f({ platform: 'web' }))).toBe(true);
    expect(isWebOnline(f({ location: 'offline' }))).toBe(true);
    expect(isWebOnline(f({ location: 'offline:offline' }))).toBe(true);
  });

  it('location 为空串也判为网页在线（原实现的漏判路径）', () => {
    expect(isWebOnline(f({ platform: '', location: '' }))).toBe(true);
    expect(isWebOnline(f({ location: undefined }))).toBe(true);
  });

  it("location 为 'traveling'（无冒号后缀）判为网页在线", () => {
    expect(isWebOnline(f({ location: 'traveling' }))).toBe(true);
  });

  it("location 为 'traveling:wrld_x'（正在传送进世界）不算网页在线", () => {
    expect(isWebOnline(f({ location: 'traveling:wrld_123:1' }))).toBe(false);
  });

  it('真实世界（wrld_ 前缀）不算网页在线', () => {
    expect(isWebOnline(f({ location: 'wrld_28d3:45176~hidden(usr_x)' }))).toBe(false);
  });

  it('离线用户一律 false（就算 platform=web）', () => {
    expect(isWebOnline({ isOnline: false, platform: 'web' })).toBe(false);
    expect(isWebOnline({ isOnline: false, location: '' })).toBe(false);
  });
});



  // ── 平台字段与位置冲突时的判据（2026-11-17）──
  // 若 platform 明确是游戏客户端（standalone/安卓/iOS），即使 location 丢了也不能判成网页在线。
  it('platform=standalone + location 空 ⇒ 不算网页在线（在游戏里，只是位置字段丢了）', () => {
    expect(isWebOnline({ isOnline: true, platform: 'standalonewindows', location: '' })).toBe(false);
    expect(isWebOnline({ isOnline: true, platform: 'android', location: '' })).toBe(false);
    expect(isWebOnline({ isOnline: true, platform: 'ios', location: 'offline' })).toBe(false);
  });

  it('platform 空 + location 空 ⇒ 网页在线（无任何游戏证据）', () => {
    expect(isWebOnline({ isOnline: true, platform: '', location: '' })).toBe(true);
  });

});
