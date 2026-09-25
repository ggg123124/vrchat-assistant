/**
 * core/offline-window.js — 对账补记离线的「窗口下界」选择（纯函数，可单测）
 *
 * 背景（2026-09-21 用户报障）：对账把「最近一次 WS 断开时刻」当作离线窗口起点，
 * 结果一次 **2 秒瞬断** 被放大成 **4.5 小时**的窗口：
 *   `API 掉线期间离线（03:15 ~ 07:50）` —— 用户读成「服务掉线 4.5 小时」，
 *   而实际上服务全程在对账（每 5 分钟一次，一直显示在线 2 人），
 *   03:23 还收到过该好友的 WS 事件；真正确定离线是 07:50 那次对账。
 *
 * 正确语义：窗口表示「他在这之后的某个时刻下线了」，下界应取
 * **最后一次能证明他在线的时刻**——即以下三者中的**最大值**：
 *   ① lastSeen       他最后一次活动/事件（WS 事件会刷新，friends.last_seen）
 *   ② lastOnlineSeen 最近一次对账确认他在在线集合中（通常 ≤ 一个对账周期）
 *   ③ disconnectedAt 最近一次 WS 断开（仅当它确实更晚时才用得上）
 * 三者都取不到时返回 ''，由调用方决定兜底文案。
 */

/**
 * @param {{lastSeen?: string, lastOnlineSeen?: string, disconnectedAt?: string}} input
 * @returns {string} ISO 时间串（最紧的窗口下界），或 '' 表示无可用下界
 */
export function pickOfflineWindowStart(input = {}) {
  const candidates = [input.lastSeen, input.lastOnlineSeen, input.disconnectedAt]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
  if (!candidates.length) return '';
  // ISO 8601（同格式/同区）可直接按字典序比较时间先后
  return candidates.reduce((a, b) => (b > a ? b : a));
}
