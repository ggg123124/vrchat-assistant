/**
 * 通知收件箱 handler — 读取 / 标记已读 / 隐藏 / 接受/拒绝好友请求
 *
 * 基于 VRChat 旧 v1 通知系统（/auth/user/notifications）。
 * 注意：type 查询参数已废弃不生效，客户端过滤；群组邀请/活动属 NotificationV2（/notifications 端点），本模块不覆盖。
 */

import { ctx, log } from '../server-context.js';

// 通知类型枚举（旧 v1 系统）
const NOTIFICATION_TYPES = ['boop', 'friendRequest', 'invite', 'inviteResponse', 'message', 'requestInvite', 'requestInviteResponse', 'votetokick'];

// REST 响应中 details 是 JSON 编码字符串（WS 才是对象），统一解码
function parseDetails(details) {
  if (details === null || details === undefined) return null;
  if (typeof details === 'object') return details;
  try { return JSON.parse(details); } catch { return null; }
}

function formatNotification(n) {
  return {
    id: n.id,
    type: n.type,
    message: n.message || '',
    senderUserId: n.senderUserId || null,
    senderUsername: n.senderUsername || null,
    details: parseDetails(n.details),
    createdAt: n.created_at || null,
    hidden: n.hidden ?? null,
  };
}

export async function handleGetNotifications({ limit = 30, offset = 0, types, hidden = false }) {
  const { api } = ctx;
  const n = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const params = `n=${n}&offset=${off}`;
  const r = await api._request('GET', `/auth/user/notifications?${params}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const all = Array.isArray(r.data) ? r.data : [];
  let list = all.filter(x => hidden ? !!x.hidden : !x.hidden);
  if (types) {
    const typeSet = new Set(String(types).split(',').map(t => t.trim()));
    list = list.filter(x => typeSet.has(x.type));
  }
  return {
    returned: all.length,
    shown: list.length,
    hasMore: all.length >= n,
    limit: n,
    offset: off,
    filteredByTypes: types ? String(types).split(',').map(t => t.trim()) : null,
    notifications: list.map(formatNotification),
  };
}

export async function handleSeeNotification({ notificationId }) {
  if (!notificationId) throw new Error('notificationId is required');
  const { api } = ctx;
  const r = await api._request('PUT', `/auth/user/notifications/${notificationId}/see`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  return { notificationId, seen: true, ok: true };
}

export async function handleHideNotification({ notificationId }) {
  if (!notificationId) throw new Error('notificationId is required');
  const { api } = ctx;
  const r = await api._request('PUT', `/auth/user/notifications/${notificationId}/hide`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  return { notificationId, hidden: true, ok: true };
}

// 接受好友请求 = 加好友（不可逆，必须 confirm）
export async function handleAcceptFriendRequest({ notificationId, confirm }) {
  if (!notificationId) throw new Error('notificationId is required');
  if (!confirm) {
    return { notificationId, confirmRequired: true, message: '接受好友请求会直接加为好友，请传 confirm: true 确认执行' };
  }
  const { api } = ctx;
  // 先校验该通知确为好友请求，避免误操作
  const r = await api._request('PUT', `/auth/user/notifications/${notificationId}/accept`);
  if (r.status === 404) throw new Error('该好友请求不存在或已处理');
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  log(`✅ accept_friend_request: ${notificationId}`);
  return { notificationId, accepted: true, ok: true };
}

// 拒绝好友请求 = 隐藏（清除）该通知；旧 v1 无独立拒绝端点，hide 即清除
export async function handleDeclineFriendRequest({ notificationId, confirm }) {
  if (!notificationId) throw new Error('notificationId is required');
  if (!confirm) {
    return { notificationId, confirmRequired: true, message: '拒绝好友请求会清除该通知（对方不会收到明确拒绝提示），请传 confirm: true 确认执行' };
  }
  const { api } = ctx;
  const r = await api._request('PUT', `/auth/user/notifications/${notificationId}/hide`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  log(`✅ decline_friend_request: ${notificationId}`);
  return { notificationId, declined: true, ok: true };
}
// ── MCP 自声明工具表 ──
export const tools = [
  {
    "name": "get_notifications",
    "description": "[query·通知] 通知收件箱：读取当前账号的未读通知（旧 v1 系统）。limit(1-100)/offset 分页；types 逗号分隔过滤（friendRequest/invite/message/boop/requestInvite/votetokick/inviteResponse/requestInviteResponse）；hidden=true 查看已隐藏通知。返回字段：returned（本页 API 实际返回条数）、shown（types 过滤后条数）、hasMore（本页取满 limit 时可能有下一页）、limit/offset。注意：API 的 type 查询参数已废弃不生效，过滤在本地完成；seen/receiverUserId 仅 WebSocket 推送有，REST 不返回。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "number",
          "default": 30,
          "description": "Max results (1-100, default 30)"
        },
        "offset": {
          "type": "number",
          "default": 0
        },
        "types": {
          "type": "string",
          "description": "Comma-separated types: friendRequest/invite/message/boop/requestInvite/votetokick (default all)"
        },
        "hidden": {
          "type": "boolean",
          "default": false,
          "description": "List hidden notifications instead of active ones"
        }
      }
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleGetNotifications(args))
  },
  {
    "name": "see_notification",
    "description": "[write·通知] 标记通知为已读。notificationId 必填。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "notificationId": {
          "type": "string",
          "description": "Notification ID (not_... / frq_...)"
        }
      },
      "required": [
        "notificationId"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleSeeNotification(args))
  },
  {
    "name": "hide_notification",
    "description": "[write·通知] 隐藏/清除一条通知（旧 v1 系统 hide 即删除）。notificationId 必填。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "notificationId": {
          "type": "string",
          "description": "Notification ID (not_... / frq_...)"
        }
      },
      "required": [
        "notificationId"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleHideNotification(args))
  },
  {
    "name": "accept_friend_request",
    "description": "[write·社交] 接受好友请求（PUT /auth/user/notifications/{id}/accept）——接受即直接加为好友，不可逆，必须传 confirm: true 才执行，否则只返回预览。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "notificationId": {
          "type": "string",
          "description": "Friend request notification ID (frq_...)"
        },
        "confirm": {
          "type": "boolean",
          "description": "Must be true to actually accept (adds the user as friend). Default false returns preview only."
        }
      },
      "required": [
        "notificationId"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleAcceptFriendRequest(args))
  },
  {
    "name": "decline_friend_request",
    "description": "[write·社交] 拒绝好友请求（旧 v1 无独立拒绝端点，hide 即清除该通知）。对方不会收到明确拒绝提示，必须传 confirm: true 才执行，否则只返回预览。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "notificationId": {
          "type": "string",
          "description": "Friend request notification ID (frq_...)"
        },
        "confirm": {
          "type": "boolean",
          "description": "Must be true to actually decline (clears the notification). Default false returns preview only."
        }
      },
      "required": [
        "notificationId"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleDeclineFriendRequest(args))
  }
];
