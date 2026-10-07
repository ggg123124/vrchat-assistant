/**
 * core/profile-bio.js — 简介(bio)的唯一读取入口（2026-10-07）
 *
 * 背景（生产实测）：新版资料系统把 `bio` **移出了 user 对象** —— WS 载荷与 `GET /users/{id}`
 * 都**没有 `bio` 键**，只有 **`GET /profile/{userId}`** 返回它（`/users/{id}/profile` 为 404）。
 * ⇒ **任何仍读 `user.bio` 的路径都会静默失真**：拿去 diff 会误报「简介被清空」并产假事件、
 *   拿去显示会永远空白（2026-10-07 用户报障「简介变更全是已清空」的根因）。
 *
 * 语义约定（必须与 core/event-pipeline.js 的 hasBioField 守卫一致）：
 *   - 返回 **string**    ＝ 拿到真值（可以是空串：对方确实没写简介）
 *   - 返回 **undefined** ＝ **未知**（请求失败 / 响应缺 bio 键）⇒ 调用方**不得 diff、不得写库**
 */

/**
 * 读某人的简介真值。
 * @param {{_request: Function}} api VRChat API client（内部走统一的限流/留痕）
 * @param {string} userId
 * @returns {Promise<string|undefined>} 简介文本；**undefined = 未知**
 */
export async function fetchProfileBio(api, userId) {
  if (!api || !userId || typeof api._request !== 'function') return undefined;
  try {
    const r = await api._request('GET', `/profile/${encodeURIComponent(userId)}`);
    if (!r || r.status !== 200 || !r.data || typeof r.data !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(r.data, 'bio')) return undefined;
    return typeof r.data.bio === 'string' ? r.data.bio : undefined;
  } catch {
    return undefined;   // 请求异常＝未知（api 层已按「外部调用留痕规范」记 WARN）
  }
}

/**
 * 是否需要记一条 bio 变更事件（纯函数，便于用例断言）。
 * **bioText === undefined（未知）一律 false** —— 本次修复的核心：缺字段不得当成「变成空」。
 * @param {string} prevBio 已有基线（空串表示此前没有简介）
 * @param {string|undefined} bioText 本次真值（undefined = 未知）
 */
export function bioChanged(prevBio, bioText) {
  if (bioText === undefined) return false;
  if (!prevBio) return false;          // 无基线：只建基线、不产事件（与既有口径一致）
  return String(prevBio) !== String(bioText);
}
