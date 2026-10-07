// event-types 纯函数单测（重构行为等价锚点）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { typeOf, isNotiUpdate, TYPE_LABELS, TYPE_ICONS, TYPE_SEVERITIES, eventTypeLabel, serverUpdateTypes, SERVER_FILTERABLE_TYPES } from './event-types.js';

describe('typeOf 归一化', () => {
  it('位置/上下线/状态', () => {
    expect(typeOf({ type: 'friend-location' })).toBe('location');
    expect(typeOf({ type: 'user-location' })).toBe('location');
    expect(typeOf({ type: 'friend-online' })).toBe('online');
    expect(typeOf({ type: 'friend-offline' })).toBe('offline');
    expect(typeOf({ type: 'friend-active' })).toBe('status');
  });
  it('friend-update 按 updateType', () => {
    expect(typeOf({ type: 'friend-update', updateType: 'avatar' })).toBe('avatar');
    expect(typeOf({ type: 'friend-update', updateType: 'bio' })).toBe('bio');
    expect(typeOf({ type: 'friend-update', updateType: 'status' })).toBe('status');
    expect(typeOf({ type: 'friend-update', updateType: 'user_icon' })).toBe('userIcon');
    expect(typeOf({ type: 'friend-update', updateType: 'pronouns' })).toBe('pronouns');
    expect(typeOf({ type: 'friend-update', updateType: 'displayName' })).toBe('displayName');
    expect(typeOf({ type: 'friend-update', updateType: 'unknown-thing' })).toBe('other');
    expect(typeOf({ type: 'friend-update' })).toBe('other');
  });
  it('user-update 默认 status', () => {
    expect(typeOf({ type: 'user-update', updateType: 'avatar' })).toBe('avatar');
    expect(typeOf({ type: 'user-update' })).toBe('status');
  });
  it('通知类型', () => {
    expect(typeOf({ type: 'notification', updateType: 'friendRequest' })).toBe('friendRequest');
    expect(typeOf({ type: 'notification', updateType: 'invite' })).toBe('invite');
    expect(typeOf({ type: 'notification', updateType: 'message' })).toBe('message');
    expect(typeOf({ type: 'notification', updateType: 'group.join' })).toBe('group');
    expect(typeOf({ type: 'notification' })).toBe('notification');
    expect(typeOf({ type: 'notification-v2-update', notiGroupId: 'grp_1' })).toBe('group');
    expect(typeOf({ type: 'notification-update' })).toBe('notificationUpdate');
  });
  it('其它', () => {
    expect(typeOf({ type: 'friend-add' })).toBe('friendAdd');
    expect(typeOf({ type: 'friend-delete' })).toBe('friendDelete');
    expect(typeOf({ type: 'unknown' })).toBe('unknown');
    expect(typeOf({ type: 'content-refresh' })).toBe('contentRefresh');
    expect(typeOf({ type: 'group-joined' })).toBe('groupJoined');
    expect(typeOf({ type: 'group-member-updated' })).toBe('groupMemberUpdated');
    expect(typeOf({ type: 'group-role-updated' })).toBe('groupRoleUpdated');
    expect(typeOf({ type: 'weird-thing' })).toBe('other');
  });
});

describe('映射完整性', () => {
  it('每个归一化类型都有 label/icon/severity', () => {
    for (const t of Object.keys(TYPE_LABELS)) {
      expect(TYPE_ICONS[t], `icon for ${t}`).toBeTruthy();
      expect(TYPE_SEVERITIES[t], `severity for ${t}`).toBeTruthy();
    }
  });
  it('eventTypeLabel 兜底', () => {
    expect(eventTypeLabel({ type: 'friend-online' })).toBe('上线');
    expect(eventTypeLabel({ type: 'group-role-updated' })).toBe('群组角色更新');
    expect(eventTypeLabel({ type: 'nonsense' })).toBe('资料变动'); // typeOf 兜底 other
  });
});

describe('isNotiUpdate', () => {
  it('识别通知更新', () => {
    expect(isNotiUpdate({ type: 'notification-v2-update' })).toBe(true);
    expect(isNotiUpdate({ type: 'notification-update' })).toBe(true);
    expect(isNotiUpdate({ type: 'notification' })).toBe(false);
  });
});

// 2026-10-07：类型筛选服务端化的白名单与参数（后端映射见 core/dashboard-services.js 的 UI_UPDATE_TYPE_SQL，
// 等价性由 test/dashboard-events-type-filter.test.mjs 用同一批样本断言）
describe('serverUpdateTypes（类型筛选服务端参数）', () => {
  it('全部为可服务端过滤的值 ⇒ 返回逗号串（去重）', () => {
    expect(serverUpdateTypes(['bio'])).toBe('bio');
    expect(serverUpdateTypes(['bio', 'avatar'])).toBe('bio,avatar');
    expect(serverUpdateTypes(['bio', 'bio'])).toBe('bio');
  });
  it('含不可服务端过滤的值（位置/上下线）或混选 ⇒ 返回空串（退回客户端过滤，行为不变）', () => {
    expect(serverUpdateTypes(['location'])).toBe('');
    expect(serverUpdateTypes(['bio', 'location'])).toBe('');
    expect(serverUpdateTypes([])).toBe('');
    expect(serverUpdateTypes(null)).toBe('');
  });
  it('白名单与后端 UI_UPDATE_TYPE_SQL 的键一致（读后端源码，真护栏）', () => {
    // ⚠️ 2026-10-07 评审 💡2：原断言只是与一份硬编码字面量比较（自证）——后端增删键它不会红。
    // 现改为**读后端源码**逐个断言键存在：后端改了键、前端没跟 ⇒ 这条变红。
    const src = readFileSync(fileURLToPath(new URL('../../../../../../core/dashboard-services.js', import.meta.url)), 'utf8');
    for (const k of SERVER_FILTERABLE_TYPES) {
      expect(src.includes(k + ':'), `后端 UI_UPDATE_TYPE_SQL 应有键 ${k}`).toBe(true);
    }
    expect([...SERVER_FILTERABLE_TYPES].sort()).toEqual(['avatar', 'bio', 'status', 'trustLevel']);
  });
});
