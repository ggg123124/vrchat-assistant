/**
 * Safe-mode subsystem — 破坏性工具过滤
 *
 * 控制环境变量：VRC_MONITOR_SAFE_MODE
 * 启用值（忽略大小写）："true" / "1" / "yes"
 */

export const DESTRUCTIVE_TOOLS = [
  'remove_print',
  'remove_gallery_image',
  'remove_friend',
  'remove_from_backlog',
  'remove_from_watchlist',
  'leave_group',
  'unfavorite_friend',
  'move_friend_group',
  'hide_notification',
  'decline_friend_request',
];

export function isSafeMode() {
  const v = process.env.VRC_MONITOR_SAFE_MODE;
  if (typeof v !== 'string') return false;
  return ['true', '1', 'yes'].includes(v.trim().toLowerCase());
}

export function isDestructive(name) {
  if (DESTRUCTIVE_TOOLS.includes(name)) return true;
  const prefixes = ['remove_', 'delete_', 'leave_', 'decline_', 'hide_', 'unfavorite_', 'unfriend_'];
  return prefixes.some(prefix => name.startsWith(prefix));
}

export function applySafeMode(tools) {
  if (!isSafeMode()) return tools;
  return tools.filter(t => !isDestructive(t.name));
}

export function assertToolAllowed(name) {
  if (isSafeMode() && isDestructive(name)) {
    throw new Error(`Tool "${name}" is blocked in safe mode (VRC_MONITOR_SAFE_MODE=true 下禁用破坏性工具)`);
  }
}
