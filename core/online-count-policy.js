import { isWebPresence } from './event-pipeline.js';

/**
 * core/online-count-policy.js — 「在线好友数」计数口径（纯函数，可单测）
 *
 * 背景：VRChat 的好友转【网页/移动端在线】时，REST 返回的是 platform='web' + location='offline'
 * （且 WS 只发 friend-active{platform:'web'}，【不发 friend-offline】）。若计数只看"有有效 location"，
 * 这些好友就被算作离线 ⇒ 状态文案 / MCP get_online_friends 的数字会比好友列表少一截。
 *
 * 开关（用户 2026-09-15 要求"口径类选择做成开关，不要写死"）：
 *   VRC_MONITOR_ONLINE_INCLUDE_WEB  默认 1=计入；0=只算游戏内有位置的好友
 * ⚠️ 只影响【计数】——状态文案的 {total}/{webOnline}/{gameOnline} 是绝对值、不受影响；
 *    好友列表的「网页在线」分组展示也不受影响。
 */

/** 读开关：未设/空 ⇒ 默认计入；只有显式 0 才关闭（与旧实现语义一致，避免行为漂移） */
export function readOnlineCountIncludeWeb(env = process.env) {
  const raw = env ? env.VRC_MONITOR_ONLINE_INCLUDE_WEB : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return Number(raw) !== 0;
}

/**
 * 单条 REST 在线记录是否计入「在线好友数」。
 * ① 有有效 location（非空、非 'offline'）⇒ 算在线（与 issue #114 的"无位置 active/菜单用户不算"一致）
 * ② 否则：网页/移动端在线 且 开关打开 ⇒ 也算在线
 */
export function isOnlineForCount(entry, includeWeb) {
  const f = entry || {};
  if (f.location && f.location !== 'offline') return true;
  return !!includeWeb && isWebPresence(f.platform);
}
