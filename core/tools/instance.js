/**
 * 实例 handler — 创建实例 / 自邀请 / 打开世界
 */

import { ctx } from '../server-context.js';
import { openInstance } from '../vrchat-launch.js';

export async function handleCreateInstance({ worldId, type, region, instanceId, groupAccessType }) {
  const { api } = ctx;
  if (!worldId || !String(worldId).startsWith('wrld_')) {
    throw new Error('worldId 必须是 wrld_ 开头（如 wrld_xxxx）');
  }
  const instType = type || 'hidden';
  const body = {
    worldId,
    type: instType,
    region: region || 'jp',
  };
  if (instanceId) body.instanceId = instanceId;
  if (groupAccessType) body.groupAccessType = groupAccessType;
  // 非 public 实例必须显式带 ownerId（=当前用户），否则 API 400 "Invalid owner ID"（2026-08-09 实测）
  if (instType !== 'public') {
    await api.ensureAuth();
    const me = (api.currentUser && api.currentUser.id) || null;
    if (!me) throw new Error('无法获取当前用户 ID，不能创建非公开实例');
    body.ownerId = me;
  }
  const r = await api._request('POST', '/instances', body);
  if (r.status >= 400) {
    throw new Error(`创建实例失败 API ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  const d = r.data || {};
  return {
    success: true,
    worldId: d.worldId || worldId,
    type: d.type || body.type,
    region: d.region || body.region,
    instanceId: d.instanceId || d.id || null,
    location: d.location || null,
    shortName: d.shortName || null,
    capacity: d.capacity || null,
  };
}

export async function handleInviteMyself({ location, worldId, instanceId, forceApi }) {
  const { api } = ctx;
  // 统一入口（与 open_world 同一套）：管道直发优先（游戏内静默弹加入菜单），
  // 管道不可用/非 Windows 时静默回退 API 自我邀请（客户端收到通知接受后传送）
  let loc = location;
  if (loc && typeof loc === 'string') {
    const idx = loc.indexOf(':');
    if (idx <= 0) throw new Error('location 格式应为 worldId:instanceId（如 wrld_x:12345~hidden(usr_x)~region(jp)）');
    if (!String(loc).startsWith('wrld_')) throw new Error('location 必须是 wrld_ 开头的完整实例串');
  } else {
    if (!worldId || !String(worldId).startsWith('wrld_')) throw new Error('worldId 必须是 wrld_ 开头');
    if (!instanceId) throw new Error('instanceId 不能为空（可用 create_instance 返回的 location）');
    loc = `${worldId}:${instanceId}`;
  }
  const res = await openInstance({ location: loc, api, forceApi: !!forceApi });
  if (!res.success) throw new Error(res.error || '邀请自己失败');
  const wId = loc.slice(0, loc.indexOf(':'));
  const iId = loc.slice(loc.indexOf(':') + 1);
  return {
    success: true,
    method: res.method,
    worldId: wId,
    instanceId: iId,
    notificationId: res.notificationId || null,
    notificationType: null,
    detail: res.detail || null,
  };
}

export async function handleOpenWorld({ worldId, location, type, region, shortName, forceApi }) {
  const { api } = ctx;
  // 1) 定位目标实例：直接给 location 就用它；只给 worldId 就先建实例（复用 handleCreateInstance）
  let loc = location;
  let sn = shortName || null;
  if (!loc || typeof loc !== 'string') {
    if (!worldId || !String(worldId).startsWith('wrld_')) {
      throw new Error('需要 worldId（wrld_ 开头，自动建实例后打开）或 location（完整实例串直接打开）');
    }
    const inst = await handleCreateInstance({ worldId, type, region });
    if (!inst.location) throw new Error('创建实例成功但未返回 location，无法打开');
    loc = inst.location;
    sn = sn || inst.shortName || null;
  } else if (!String(loc).startsWith('wrld_')) {
    throw new Error('location 必须是 wrld_ 开头的完整实例串（如 wrld_x:12345~hidden(usr_x)~region(jp)）');
  }
  // 2) 统一入口：管道直发（静默弹窗）→ 探测失败静默回退 API 自我邀请
  const res = await openInstance({ location: loc, shortName: sn, api, forceApi: !!forceApi });
  if (!res.success) throw new Error(res.error || '打开实例失败');
  return {
    success: true,
    method: res.method,
    location: loc,
    shortName: sn,
    notificationId: res.notificationId || null,
    detail: res.detail || null,
  };
}

// ── MCP 自声明工具表 ──
export const tools = [
  {
    "name": "create_instance",
    "description": "[write·vrchat] Create a new instance (room) for a world. Returns instance location ready for invite_myself. Region defaults to jp.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "World id (wrld_...)"
        },
        "type": {
          "type": "string",
          "description": "Instance type: public/hidden/friends/private/group (default hidden)"
        },
        "region": {
          "type": "string",
          "description": "Region: us/eu/jp (default jp)"
        },
        "instanceId": {
          "type": "string",
          "description": "Optional: existing instance id (shortName or full) to join instead of creating fresh"
        },
        "groupAccessType": {
          "type": "string",
          "description": "Required when type=group: members/plus/public"
        }
      },
      "required": [
        "worldId"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleCreateInstance(args))
  },
  {
    "name": "invite_myself",
    "description": "[write·vrchat] Open an instance in the running VRChat client (same engine as open_world): named-pipe launch first (Windows, silent in-game join dialog), falls back to API self-invite (client teleports on accept) when pipe unavailable. Accepts location (worldId:instanceId) or worldId+instanceId separately.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "location": {
          "type": "string",
          "description": "Full location string, e.g. wrld_x:12345~hidden(usr_x)~region(jp). If provided, worldId/instanceId are ignored."
        },
        "worldId": {
          "type": "string",
          "description": "World id (wrld_...) — ignored if location is provided"
        },
        "instanceId": {
          "type": "string",
          "description": "Instance id (full format with ~region etc.) — ignored if location is provided"
        },
        "forceApi": {
          "type": "boolean",
          "description": "Skip pipe detection and force API self-invite (remote/test scenarios)"
        }
      }
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleInviteMyself(args))
  },
  {
    "name": "open_world",
    "description": "[write·vrchat] Open a world/instance in the running VRChat client. If only worldId given, creates a new instance first (hidden jp default), then: named-pipe launch (VRChatURLLaunchPipe → silent in-game join dialog, Windows, 1 step) with API self-invite fallback (invite notification) when pipe unavailable. Core: core/vrchat-launch.js openInstance.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "World id (wrld_...) — creates a new instance (type/region) then opens it"
        },
        "location": {
          "type": "string",
          "description": "Full instance location to open directly, e.g. wrld_x:12345~hidden(usr_x)~region(jp). If given, worldId/type/region are ignored."
        },
        "type": {
          "type": "string",
          "description": "Instance type when creating from worldId: public/hidden/friends/private/group (default hidden)"
        },
        "region": {
          "type": "string",
          "description": "Region when creating from worldId: us/eu/jp (default jp)"
        },
        "shortName": {
          "type": "string",
          "description": "Optional room short name shown in the launch menu"
        },
        "forceApi": {
          "type": "boolean",
          "description": "Skip pipe detection and force API self-invite (remote/test scenarios)"
        }
      }
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleOpenWorld(args))
  }
];
