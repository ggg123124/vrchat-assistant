# VRChat 信任等级/在线状态颜色 + 收藏 API 坑（2026-08-26 会话）

> 把 Dashboard 对齐 VRCX 的信任等级彩色徽章、在线状态灯、仅网页在线区分、收藏夹分组时查证与踩坑的记录。

## 流程教训（用户明确纠正，最高优先）

实现依赖**外部规范**的显示（信任等级颜色、状态颜色、任何"标准色/标准值/标准规则"）时，**必须先搜索查证**（VRCX 源码 presets / 官方 wiki / API 文档），不要凭记忆写。用户原话："你好歹搜一下vrchat信用等级再做啊"。

## VRChat 信任等级颜色（VRCX 官方默认 presets，InterfaceTab.vue `trustColorEntries`）

| 等级 | VRCX 默认色 |
|---|---|
| Visitor 游客 | `#CCCCCC` 灰 |
| New User 萌新 | `#1778ff` 蓝 |
| User 玩家 | `#2bcf5c` 绿 |
| Known User | `#ff7b42` 橙 |
| Trusted User | `#b18fff` 紫 |
| VRChat Team | `#ff2626` 红 |
| Nuisance | `#782f2f` 深红 |

**关键坑：Known User=橙、Trusted User=紫**（不是直觉的 Known=蓝/Trusted=绿）。VRChat tag 有 offset 1（VRCX `shared/utils/userTransforms.js` `computeTrustLevel`）：`system_trust_veteran`→Trusted User、`system_trust_trusted`→Known User、`system_trust_known`→User、`system_trust_basic`→New User、无 tag→Visitor。现行等级仅 5 级（Visitor/New User/User/Known User/Trusted User）；Veteran/Legendary 是 2018 年前旧名。
- API `trustLevel` 直接返回完整名（"Trusted User"/"Known User"/"New User"/"Visitor"），friends 表有 `trust_level` 列。
- 前端映射顺序（名字都含 'user'，先匹配更具体的）：`trusted`→紫 → `known`→橙 → `new`→蓝 → `user`→绿 → else 灰 → `team|moderator`→红。

## VRChat 在线状态颜色

- status 颜色（官方）：`active`绿 / `join me`蓝 / `ask me`黄 / `busy`红 / 离线灰。
- **仅网页在线**：`isOnline=1` 且 `platform` 含 `web` → 只登录了网页端、**不在游戏内、无位置**。UI 用**灰色灯** + "仅网页在线" + 位置"—"，与游戏内在线（status 色灯 + 世界名/实例）区分；`isOnline=0` 的 web 不算。
- friends 表有 `platform` 列（standalonewindows/android/web…），`dashboard.friends` DTO 已带出 `platform`。

## 收藏 API 坑（favorites?type=world 按收藏夹分组）

- `/favorites?type=world` 返回的 favorite 对象：**`favoriteId` = worldId**、`id` = favorite 记录 id（`fvrt_xxx`）、**收藏夹名在 `tags`**（如 `["worlds2"]`），**没有 `favoriteGroupId` 字段**。按收藏夹分组：`w2g.set(f.favoriteId, f.tags[0])` 再回填到每个 world 的 `favoriteGroup`。
- `get_my_favorite_groups` 工具 DTO **丢 group id**（只返回 name/capacity）→ 无法用 favoriteGroupId 映射；需直连 `api.vrchat.fetch('/favorite/groups')` 拿原始 `g.id`。
- VRChat 客户端"默认收藏夹"在 API 里命名 worlds1-4（`tags: ["worldsN"]`）。

## world_cache 空名占位 + 世界名回填模式

- `get_world_name` 缓存命中（含 `name=''` 的占位记录）**不走 API**，必须 `forceRefresh: true` 才刷新写缓存。
- world_cache 列名是 **`world_id`**（不是 `id`）。
- VRChat 已下架/隐藏世界：API 返回空名（`content.world.name=null`、`/worlds/{id}` name=''）→ 无法显示名字，属数据极限 → UI 显示"未知世界"，别露 `wrld_xxx` 原文。
- **回填器模式**（插件侧，遵守 core/plugin 边界）：核心加只读服务 `dashboard.emptyWorldIds`（查 world_cache 中 name='' 的 world_id 列表）→ 插件 register 内启动即跑 + `setInterval` 定期 `api.consume('dashboard.emptyWorldIds')` 逐个 `api.tools.call('get_world_name', {worldId, forceRefresh:true})`（核心 rateLimiter 自动限流）→ register `return () => clearInterval(timer)` 作 disposer（plugin-loader 支持 `plugin.dispose = typeof result==='function'`）。
- 事件 worldName 解析优先级：`content.world.name` → `COALESCE(NULLIF(e.world_name,''), wc.name, '')`（friends/events/recentWorlds 服务里已 LEFT JOIN world_cache）。

## 其他

- `friend-update` avatar 事件 `avatarName` 常空（VRChat 不推模型名）→ UI 用新旧头像缩略图对比（`avatarImageUrl` / `previousAvatarImageUrl`）展示"换成了什么模型"。
- `not_` 前缀的 userId = 通知事件（非用户），点击不该弹玩家资料；前端事件点击路由要过滤（`userId.startsWith('not_')` 跳过 openUser）。
