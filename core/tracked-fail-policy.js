// 2026-09-23 issue #241 评审（⚠️2 / 💡2）：把「是否需要退避/淘汰」的判定抽成**可导入的纯函数**，
// 这样测试能直接驱动它（而不是复刻 SQL ✓），且判据只有一处 ✓。
//
// ⚠️2 的关键取舍：**只把 404 当永久失效信号** ✓ ——
// 429（限流）/ 5xx（上游故障）都是**暂时性**的，连续 3 轮（约 3 小时）不该把有效条目软删除；
// 而 _seedTrackedNonFriends 会跳过软删除条目 ⇒ 一旦误杀**不会自愈**，要使用者手工重加 ✗。
export const TRACKED_FAIL_LIMIT = 3;

/**
 * 判定一次刷新失败该如何处理（纯函数，便于测试直接驱动 ✓）
 * @param {object} p  { failCount?: number, status?: number, hasDataError?: boolean }
 * @returns {{next: number, remove: boolean, permanent: boolean, reason: string}}
 */
export function decideTrackedFail(p) {
  const status = Number(p && p.status) || 0;
  const err = !!(p && p.hasDataError);
  // 只有「明确 404」（用户已不存在）才算永久失效；其余（429 / 5xx / 200-但含 error）只记录、不累计到淘汰
  const permanent = status === 404;
  if (!permanent) {
    return { next: Number((p && p.failCount) || 0), remove: false, permanent: false, reason: err ? '响应内含错误（暂时性，不累计）' : ('HTTP ' + status + '（暂时性，不累计）') };
  }
  const next = Number((p && p.failCount) || 0) + 1;
  return { next: next, remove: next >= TRACKED_FAIL_LIMIT, permanent: true, reason: 'HTTP 404（用户已不存在）' };
}
