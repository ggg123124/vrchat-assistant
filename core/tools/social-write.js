/**
 * Social write tools — send_boop / send_invite / request_invite
 *
 * 这些工具原本内联在旧路由层，现拆分为自声明工具。
 */

import { ctx, log } from '../server-context.js';

export async function handleSendBoop({ userId, emojiId }) {
  const { api, rateLimiter } = ctx;
  const r = await rateLimiter.execute(() => api.sendBoop(userId, emojiId || ''));
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { success: true, userId, booped: true };
}

export async function handleSendInvite({ userId, worldId, instanceId, message }) {
  const { api, rateLimiter } = ctx;
  await rateLimiter.execute(() => api.ensureAuth());
  const body = { instanceId: `${worldId}:${instanceId}` };
  if (message) body.message = message;
  const r = await rateLimiter.execute(() => api._request('POST', `/invite/${userId}`, body));
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { success: true, userId, invited: true };
}

export async function handleRequestInvite({ userId, message }) {
  const { api, rateLimiter } = ctx;
  await rateLimiter.execute(() => api.ensureAuth());
  const r = await rateLimiter.execute(() => api._request('POST', `/requestInvite/${userId}`, {
    message: message || 'Can I join you?',
    platform: 'standalonewindows',
  }));
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { success: true, userId, requestSent: true };
}

export const tools = [
  {
    name: 'send_boop',
    description: '[write·vrchat] Send a boop to a user. Requires userId.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        emojiId: { type: 'string', description: 'Optional emoji ID' },
      },
      required: ['userId'],
    },
    handler: async (args) => handleSendBoop(args),
  },
  {
    name: 'send_invite',
    description: '[write·vrchat] Send an invite to join your current instance.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        worldId: { type: 'string' },
        instanceId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['userId', 'worldId', 'instanceId'],
    },
    handler: async (args) => handleSendInvite(args),
  },
  {
    name: 'request_invite',
    description: '[write·vrchat] Request an invite from a user.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['userId'],
    },
    handler: async (args) => handleRequestInvite(args),
  },
];
