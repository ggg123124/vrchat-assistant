// 事件类型 → 展示元数据（label/icon/severity/归一化 typeOf）
// 从 FeedView.vue 抽取：纯数据层，可单测、可复用（用户弹窗活动记录等也消费同一套类型语义）

export const TYPE_LABELS = {
  location: '位置变动', online: '上线', offline: '下线', status: '状态变动', avatar: '模型变动',
  bio: '简介变更', userIcon: '头像图标', pronouns: '代词变更', displayName: '改名',
  friendRequest: '好友申请', invite: '邀请', message: '私信', group: '群组通知',
  notification: '通知', notificationUpdate: '通知更新', friendAdd: '新增好友', friendDelete: '删除好友',
  unknown: '未知事件', contentRefresh: '内容库', groupJoined: '加入群组', groupMemberUpdated: '群组更新',
  other: '资料变动',
};

export const TYPE_ICONS = {
  location: 'pi-map-marker', online: 'pi-sign-in', offline: 'pi-sign-out', status: 'pi-heart',
  avatar: 'pi-user-edit', bio: 'pi-file-edit', userIcon: 'pi-id-card', pronouns: 'pi-user',
  displayName: 'pi-pencil', friendRequest: 'pi-user-plus', invite: 'pi-arrow-right-arrow-left',
  message: 'pi-comment', group: 'pi-users', notification: 'pi-bell', notificationUpdate: 'pi-bell',
  friendAdd: 'pi-user-plus', friendDelete: 'pi-user-minus', unknown: 'pi-question-circle',
  contentRefresh: 'pi-refresh', groupJoined: 'pi-users', groupMemberUpdated: 'pi-users', other: 'pi-user',
};

export const TYPE_SEVERITIES = {
  location: 'info', online: 'success', offline: 'secondary', status: 'warning', avatar: 'warn',
  bio: 'contrast', userIcon: 'secondary', pronouns: 'contrast', displayName: 'warn',
  friendRequest: 'success', invite: 'info', message: 'secondary', group: 'warn',
  notification: 'secondary', notificationUpdate: 'secondary', friendAdd: 'success',
  friendDelete: 'danger', unknown: 'secondary', contentRefresh: 'info', groupJoined: 'success',
  groupMemberUpdated: 'warn', other: 'secondary',
};

// 事件 → 归一化类型（兼容后端多种历史形状；纯函数，行为与 FeedView 原实现一致）
export function typeOf(x) {
  if (x.type === 'friend-location' || x.type === 'user-location') return 'location';
  if (x.type === 'friend-online') return 'online';
  if (x.type === 'friend-offline') return 'offline';
  if (x.type === 'friend-active') return 'status';
  if (x.type === 'friend-update') {
    if (x.updateType === 'avatar') return 'avatar';
    if (x.updateType === 'bio') return 'bio';
    if (x.updateType === 'status') return 'status';
    if (x.updateType === 'user_icon') return 'userIcon';
    if (x.updateType === 'pronouns') return 'pronouns';
    if (x.updateType === 'displayName') return 'displayName';
    return 'other';
  }
  // 自己的资料/状态更新：与 friend-update 一致显示（状态灯/简介/模型）；
  // 旧格式（无 updateType）默认按状态变动——用户视角就是"在线状态更新"
  if (x.type === 'user-update') {
    if (x.updateType === 'avatar') return 'avatar';
    if (x.updateType === 'bio') return 'bio';
    if (x.updateType === 'user_icon') return 'userIcon';
    if (x.updateType === 'pronouns') return 'pronouns';
    if (x.updateType === 'displayName') return 'displayName';
    return 'status';
  }
  if (x.type === 'friend-add') return 'friendAdd';
  if (x.type === 'friend-delete') return 'friendDelete';
  if (x.type === 'unknown') return 'unknown';
  if (x.type === 'content-refresh') return 'contentRefresh';
  if (x.type === 'group-joined') return 'groupJoined';
  if (x.type === 'group-member-updated') return 'groupMemberUpdated';
  if (x.type === 'hide-notification' || x.type === 'see-notification') return 'notificationUpdate';
  if (x.type === 'notification' || x.type === 'notification-v2') {
    const t = x.updateType || x.notificationType || '';
    if (t === 'friendRequest') return 'friendRequest';
    if (t === 'invite' || t === 'requestInvite') return 'invite';
    if (t === 'message') return 'message';
    if (String(t).startsWith('group.')) return 'group';
    return 'notification';
  }
  // 通知状态更新：关联到群组通知的归入"群组通知"，否则"通知更新"
  if (x.type === 'notification-v2-update' || x.type === 'notification-update') {
    return x.notiGroupId ? 'group' : 'notificationUpdate';
  }
  return 'other';
}

export function isNotiUpdate(x) {
  return x.type === 'notification-v2-update' || x.type === 'notification-update';
}

export function eventTypeLabel(x) {
  return TYPE_LABELS[typeOf(x)] || '通知';
}
