# VRChat Dashboard 2026-08 尾部：用户推翻的两个判定 + 新事故

> 本文件记录对既有 reference 的**修正**（用户反馈后翻 VRCX 源码实证）与本会话新增事故。
> 若与旧 reference 冲突，**以此文件为准**。

## 修正 1：网页在线判定 = 仅 `platform==='web'`

旧 reference（vrchat-api-auth-friends-backfill.md）的"网页在线判定（修正版）"已被用户推翻。

**用户反馈**："Helionix 明明上线了你却说他仅网页在线"（Helionix 是 `platform=standalonewindows + location='private' + status='active'`，游戏内私人实例）。

**翻 VRCX 源码结论**（src/shared/utils/user.js）：
- `location==='offline'` → 离线（style.offline），**不是网页在线**
- `location==='private'` + `status==='active'` → 游戏内私人实例在线（style.online）
- 网页在线 = `platform==='web'`（VRChat API 对网页在线用户明确返回；VRCX `computeUserPlatform` 专门处理 `'web'`）

**最终实现**：`isWebOnline(x) = x.isOnline && String(x.platform||'').toLowerCase().includes('web')`。
单测同步改：`{platform:'standalonewindows',location:'offline'}`→false、`{worldId:'private'}`→false（不再是 true）。

## 修正 2：trustLevel 缺失时从 tags 推断，不用灰色兜底

旧 reference（vrchat-trust-level-missing-and-offline-status.md）的"空则灰 `#8a94a0`"方案已被用户推翻。

**用户反馈**："没获取到不要灰色。容易混淆成萌新。你研究一下VRCX到底怎么获取的。"

**实证**：VRChat API 对部分用户（如 CHIEN千苑）`/auth/user/friends` 和 `/users/{id}` 都不返回 `trustLevel` 字段，但 **`tags` 里有 `system_trust_*` 标记**。

**VRCX 做法**（src/shared/utils/userTransforms.js `computeTrustLevel`）——从 tags 推断，映射为**显示名**：
- `system_trust_veteran` → **Trusted User**（紫，最高）
- `system_trust_trusted` → **Known User**（橙）
- `system_trust_known` → **User**（绿）
- `system_trust_basic` → **New User**（蓝）

**实现**：后端补全任务 `inferTrustFromTags(tags)` 按上述映射返回显示名写入 friends.trust_level；前端 `trustColor` 正则本就匹配这些显示名（/trusted/→紫 /known/→橙 /user/→绿 /new/→蓝）。**前端不留灰色兜底**（用户明确不要），trustLevel 空就空着（补全任务会填）。

⚠️ 注意：VRChat 官方信任等级体系里 veteran 是最高，**不要**映射成 "Veteran User"（初版写错过），对齐 VRCX 是 veteran→"Trusted User"。

## 新事故：python 在 JS 文件"插入"路由段也会把结构弄坏

`dashboard-frontend-race-and-editing.md` 已记录 python **replace/正则**跨函数替换会损坏 views.js。本会话新增变体：用 `str.replace` 在 search.js **插入**一段路由（锚点 `path: '/api/dashboard/search',`），结果把前一行 `api.http.registerRoute({` 也重复了一份 → `SyntaxError: Unexpected token '.'`，**部署后插件加载失败**（用户已看到线上损坏才补修）。

**教训**：
- 插入代码段的替换锚点必须**足够唯一且不含结构边界**（本事故锚点 `path: ...` 上一行恰好是 `api.http.registerRoute({`，replace 时被吞）。
- 用 patch 工具（精确 old_string + 唯一性检查）而不是 `str.replace`。
- **任何后端/前端编辑后立即 `node --check`**，尤其是部署前；本事故就是"验证脚本因 bash 引号问题没跑、直接部署"才把损坏带到线上。

## 新增：VRChat API 能力边界（设计功能前先查）

- `/instances/{worldId}:{instanceId}` **不返回玩家列表**（只有 n_users/userCount/platforms/world）。完整玩家列表 VRChat 只通过 Photon 网络包暴露（VRCX 抓客户端包），**服务器端不可复刻**——房间玩家视图只能显示同实例在线好友。
- **服务器状态无 VRChat API 端点**：/status 404、/announcement 404、/health 401、/config 无状态。唯一公开源 `https://status.vrchat.com/api/v2/status.json`（Statuspage，无需认证），但该域名在部分网络（路由器/墙内）不可达，VRChat API 无替代——失败时前端显示占位即可。
- `/auth/user`（me）**不在实例时无 `location` 字段**（在实例才有）；在线好友位置用 `/auth/user/friends?offline=false`。
- VRChat 邀请响应：`PUT /invite/{notificationId}/response` body `{"responseSlot": 0|1}`（0 接受加入/1 拒绝），无需显式 instanceId。

## VRCX 源码关键位置（做对齐直接翻）

- 仓库：`vrcx-team/VRCX`（Electron + dotnet；不是 vrchat-community）。
- 信任等级：`src/shared/utils/userTransforms.js` `computeTrustLevel`。
- 在线/网页判定：`src/shared/utils/user.js`（location==='offline'→offline；location==='private'+status==='active'→online；$platform!=='web'→mobile）。
- 服务器状态：`src/stores/vrcStatus.js` → `status.vrchat.com/api/v2/status.json`。
