// utils 纯函数单测（重构行为等价锚点）
import { describe, it, expect } from 'vitest';
import { time, date, reltime, parseLoc, avatarLabel, isWebOnline, platformLabel, platformIcon, dateTime } from './utils.js';

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
});
