/**
 * core/friend-refresh.js — 好友资料周期刷新（2026-09-15 用户报障根治）
 *
 * 背景：服务纯 WS 驱动、无定期资料拉取。好友 trust_level 等资料字段只在 WS 事件
 * 到达时更新——等级陈旧后无自愈（实测 XIAOFANG小芳已升 Trusted User、库内仍停
 * Known User）。
 *
 * 方案演进：最初用 GET /auth/user/friends（offline=true）拉列表，实测该端点**硬性
 * 只返回 20 个**（n/offset 均不生效，offset=20 后为空）——20 个之外的好友（如小芳，
 * isFriend=true 却不在列表）永远刷不到。故改为**逐好友 GET /users/{id}**（与既有
 * _refreshTrackedNonFriends 同款先例）：返回完整 User 对象（含 tags），按
 * last_seen DESC 处理、每周期上限 VRC_MONITOR_FRIEND_REFRESH_MAX（默认 50）。
 *
 * 信任等级以 tags 推导优先（VRChat 官方展示语义：system_trust_* 层级
 * New < Known < Trusted < Veteran；列表/字段可能滞后，tags 是实时真值）。
 */
// 现行信任等级（VRChat Wiki 官方，2026-09-15 核实）：Visitor → New User → User →
// Known User → Trusted User（Trusted 最高）。Veteran/Legend 是**已移除的旧等级**
// （system_trust_veteran/legend 为老玩家遗留徽章，VRChat 移除时各档上移一级），
// 持有者按最高**现行**等级显示 = Trusted User（用户实测纠正：小芳 tags 含 trusted+veteran，
// 游戏里只显示 Trusted，没有 Veteran 这个等级）。
// VRChat tag 语义反直觉（务必与本仓既有口径一致，见 plugins/official/web-dashboard/ui/src/utils.js:165
// 的注释与 start-monitor.js 的 inferTrustFromTags）：**trusted = Known User、known = User**、
// veteran/legend 才是 Trusted User。2026-09-22 #222 审核 🔴：本表原先整体高了一档（trusted→Trusted User），
// 导致存量等级被上抬一档、且没有任何 tag 能产出 'User'（与库内实际存在的 'User' 自相矛盾）。
const TRUST_FROM_TAG = {
  system_trust_basic: 'New User',
  system_trust_known: 'User',
  system_trust_trusted: 'Known User',
  system_trust_veteran: 'Trusted User',
  system_trust_legend: 'Trusted User',
};
const TRUST_ORDER = ['New User', 'User', 'Known User', 'Trusted User'];
export function trustFromTags(tags) {
  if (!Array.isArray(tags)) return '';
  let best = '';
  for (const tag of tags) {
    const v = TRUST_FROM_TAG[tag];
    if (v && (!best || TRUST_ORDER.indexOf(v) > TRUST_ORDER.indexOf(best))) best = v;
  }
  return best;
}

/** 轮转游标（模块级）：见下方取数窗口轮转注释 */
let cycleOffset = 0;

export async function refreshFriendList(ctx, log) {
  const { api, rateLimiter, storage } = ctx;
  if (!api || !rateLimiter || !storage) return;
  const MAX_PER_CYCLE = Math.max(1, Number(process.env.VRC_MONITOR_FRIEND_REFRESH_MAX) || 50);
  let friends;
  try {
    friends = storage.query('SELECT user_id, display_name, trust_level FROM friends ORDER BY last_seen DESC');
  } catch {
    friends = [];
  }
  if (!friends.length) return;
  // 取数窗口轮转（#222 审核 ⚠️）：固定取前 MAX 个会让"最近不活跃"的好友永远刷不到；
  // 每次调用把起点后移 MAX，绕一圈回到头部（414 好友 / MAX=50 → 约 9 个周期覆盖全部）。
  const start = cycleOffset % friends.length;
  cycleOffset = (start + MAX_PER_CYCLE) % friends.length;
  if (start > 0) friends = friends.slice(start).concat(friends.slice(0, start));
  let processed = 0;
  let trustChanged = 0;
  for (const f of friends) {
    if (processed >= MAX_PER_CYCLE) break;
    processed += 1;
    let u;
    try {
      const r = await rateLimiter.execute(() => api._request('GET', `/users/${encodeURIComponent(f.user_id)}`));
      if (r.status !== 200 || !r.data || r.data.error) {
        log(`[警告] 好友资料刷新失败(${f.user_id}): HTTP ${r.status}`);
        continue;
      }
      u = r.data;
    } catch (e) {
      log(`[警告] 好友资料刷新失败(${f.user_id}): ${e.message}`);
      continue;
    }
    // #222 审核 ⚠️：与 WS 路径统一——**缺 tags 即未知**，不得回落到 `u.trust_level`（那是部分/滞后字段，
    // 回落到它会让权威值为 Known User 的好友被"降级"回 Trusted/旧值，产生假变更事件）。
    const trust = trustFromTags(u.tags) || '';
    // ① trust_level 变化记录（有基线才报，与 _handleUpdate 同规则）
    if (f.trust_level && trust && f.trust_level !== trust) {
      try {
        storage.insertEvent({
          type: 'friend-update',
          userId: u.id,
          displayName: u.displayName || f.display_name || '',
          contentJson: {
            userId: u.id,
            displayName: u.displayName || f.display_name || '',
            type: 'trust_level',
            trustLevel: trust,
            previousTrustLevel: f.trust_level,
          },
          worldId: '',
          worldName: '',
          createdAt: new Date().toISOString(),
          source: 'poll',
        });
        log(`[追踪] 好友等级变化: ${u.displayName || f.display_name}: ${f.trust_level} → ${trust}`);
        trustChanged += 1;
      } catch { /* 记录失败不影响刷新 */ }
    }
    // ② 回写资料字段（仅非空，partial upsert 不清空）
    storage.upsertFriend({
      userId: u.id,
      ...(u.displayName ? { displayName: u.displayName } : {}),
      ...(u.status ? { status: u.status } : {}),
      ...(u.statusDescription ? { statusDescription: u.statusDescription } : {}),
      ...(u.currentAvatarImageUrl ? { avatarImageUrl: u.currentAvatarImageUrl } : {}),
      ...(u.bio ? { bio: u.bio } : {}),
      ...(u.userIcon ? { userIcon: u.userIcon } : {}),
      ...(u.pronouns ? { pronouns: u.pronouns } : {}),
      ...(trust ? { trustLevel: trust } : {}),
    });
  }
  log(`[追踪] 好友资料刷新完成: ${processed}/${friends.length} 位, 等级变化 ${trustChanged} 条`);
}
