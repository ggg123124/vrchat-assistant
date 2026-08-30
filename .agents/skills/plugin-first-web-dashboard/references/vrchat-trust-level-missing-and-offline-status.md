# VRChat 信任等级缺失 + 离线状态点 + UI 精简（2026-08-26 尾部会话）

> 用户反馈"右侧面板有人的名字没上色"、"下线好友在线状态应该是灰色"后的正确做法。
> 补充 `vrchat-trust-status-and-favorites.md` 未覆盖的两个坑 + 本轮 UI 精简偏好。

## 坑：`/auth/user/friends` 可能对部分用户完全不返回 trustLevel

- 全量好友接口（`?offline=true`）返回的 user 对象**可能整段缺失 `trustLevel` 字段**（容器实测 CHIEN千苑 的 Object.keys 里无任何 trust/level/rank 相关）——watchlist 关注/非标准好友或 API 数据极限，不是前端 bug，别为它反复查 API。
- 现象：右侧好友栏名字不上色（`trustColor('')` 返回 `''` → 无 color 样式 → 默认白）。
- 修复：所有名字着色处 `style="color:${trustColor(x.trustLevel)||'#8a94a0'}"`（空则灰，与 Visitor 一致）——右侧栏 `friendList` / 好友位置页 `friendRow` / 资料弹窗 `profileHeader` 三处（`replace_all` 一次改完）。
- 回填任务扩展：好友资料补全 `_syncFriendAvatars`（启动 90s 后 + 每 6h，`/auth/user/friends?offline=true`）除了头像也 `upsertFriend({ trustLevel })`；跳过条件放宽为「头像**和** trustLevel 都有才跳过」，否则补缺字段（`if (ex && (ex.avatar_image_url || ex.user_icon) && ex.trust_level) continue`）。

## 坑：离线好友状态点要强制灰，别信 status 字段残留

- 离线好友（`!isOnline`）的 `status` 字段可能残留旧值（如 `active`）→ `statusDot(x.status)` 显示**绿点 + "离线"文字**，自相矛盾。
- 修复：状态点统一 `statusDot(x.isOnline?x.status:'offline')`；文字离线统一"离线"（`x.isOnline?(x.status||'在线'):'离线'`）；`statusDescription` 只在线时显示。
- 离线灰的 CSS 本就存在：`.sd-offline{background:var(--dim)}`，问题只在传入的 status 值。

## 用户偏好（UI 精简，延续 "收藏&星标" 批量）

- 顶部**静态副标题**（`<small id="viewSub">实时事件记录</small>`）被要求删除——顶栏只留视图标题 + 刷新按钮；删前 grep 确认无 `querySelector('#viewSub')` 引用（无引用可直接删 HTML）。
- **名称简化**："收藏&星标"→"收藏"：dashboard.html 侧栏 sidelink + 右侧栏好友分组 navgroup、app.js `_vmap` 映射三处统一改，改完 `grep -c "收藏&星标"` 应为 0。
- 改这类文案/结构先 `grep` 找全所有出现处再统一改，别只改一处。

## 本会话配套排查姿势（复现用）

- 查某好友 trustLevel 是否 API 提供：容器内 `VrchatApiClient.loadCookieFromFile('/app/data/auth_cookie.txt')` + `client._request('GET','/auth/user/friends?offline=true&n=100&offset=0')`，`Object.keys(target).filter(k=>/trust|level|rank/i.test(k))` 为空即 API 不返回。
- 名字着色审计：`re.finditer(r'.{40}trustColor\(x\.trustLevel\).{8}', views.js)` 找全部着色点。
