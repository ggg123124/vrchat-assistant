# Dashboard 开发状态档案

> 由 filesystem-context 技能（Plan Persistence 模式）维护。跨会话/上下文压缩后先读本文件恢复状态。
> 最后更新：2026-08-30

## 当前目标

将 Dashboard 前端对齐 VRCX（信息显示/解析/排版），遵守仓库 AGENT 开发规范；已完成模块化与性能优化，持续功能对齐。

## 代码结构（模块化后）

`plugins/official/web-dashboard/`
- `index.js` — 插件入口：路由组合 + 资源注入 + 预热 + 世界名回填 + 生命周期
- `dashboard.html` — 纯 HTML 骨架（约 5KB）
- `client/dashboard.css` — 前端样式（注入）
- `client/js/util.js` — 14 个纯工具函数：esc/time/date/worldLabel/parseLoc/locLabel/img/statusCls/isWebOnline/statusDot/trustBadge/eventType/notificationType*
- `client/js/views.js` — 37 个视图渲染函数：各工作区/事件行/好友行/图表/弹窗/资料
- `client/js/app.js` — 核心控制：state/render/load 调度/SSE/初始化 + 前端视图缓存
- `server/http.js` — JSON/HTML 响应、参数、请求体
- `server/state.js` — 缓存 TTL 与读写（createDashboardState/setCached/getCached）
- `server/routes/{search,favorites,avatars,social}.js` — 业务路由模块

## 性能机制（已部署）

- **后端缓存 TTL**：favoriteWorlds 30min / avatars 30min / moderation 30min / favoriteFriends 10min / homeFavorites 5min
- **后端错峰预热**：注册后 30s 启动、每 10min 一轮、逐项间隔 15s（顺序：avatars → moderation → favoriteFriends）
- **avatars stale-while-revalidate**：有旧缓存先秒回 + 后台刷新；`/auth/user` 缓存 5min（loadMe）
- **前端视图缓存**：`get()` 白名单缓存 60s（home/favorites/avatars/moderation/notifications/recent-worlds/stats），写操作（通知已读/接受/拒绝）后 invalidateViewCache
- **视图竞态保护**：`viewToken`——旧请求 token 不匹配则丢弃（load 函数签名带 token）

## 外部规范（已查证，勿凭记忆）

- **信任等级颜色（VRCX presets）**：Visitor 灰 #CCCCCC / New User 蓝 #1778ff / User 绿 #2bcf5c / Known User 橙 #ff7b42 / Trusted User 紫 #b18fff / Team 红 #ff2626
- **在线状态色**：active 绿 / join me 蓝 / ask me 黄 / busy 红 / offline 灰；仅网页在线（platform=web）灰 #8a94a0
- **VRChat 收藏 API 结构**：`favoriteId` 才是 worldId；`id` 是记录 id；收藏夹名在 `tags[0]`（如 worlds1/2/3/4）

## 部署信息

- 工作副本：`/opt/data/vrchat-assistant-work`（git 未 commit/push）
- 目标：路由器（本地局域网），目录 /opt/vrchat-assistant，容器 vrchat-assistant
- 部署方式：python3 + paramiko + tarfile（排除 .git/node_modules/data/backups/__pycache__/.system_generated/service-logs + credentials/.env）
- Dashboard 端口 8799，认证头 `Authorization: Bearer $VRC_MONITOR_AUTH_TOKEN`（容器内）

## 已知问题

- 首页 `/home` 首次 ~7.8s：`get_favorite_friends_locations` 内部 10+ 限流请求（无法插件侧消除，靠 5min 缓存 + 前端缓存）
- 预热窗口（部署后 30~75s）内用户请求会排队（avatars 已用 stale-while-revalidate 缓解）
- 世界名空值：VRChat 已下架/无名字世界在所有数据源无名字（数据极限，已用 refillWorldNames 回填可回填的）

## 已完成（2026-08-26 功能对齐）

- **好友动态分页**：`dashboard.events` 服务加 offset（SQL OFFSET），events 路由传 offset；前端 `state.feedEvents`/`feedHasMore` + `loadMoreFeed()`（每次追加 50 条）+ “加载更多”按钮（data-load-more），feed 初始 50 条（原 80）
- **SSE 实时刷新**：feed 视图时新事件到达 1s 防抖只重拉 events（`refreshFeedEvents()`，本地 DB 查询快且省）；其他视图保持 5s 防抖全量 `load()`
- **右侧好友栏按世界分组**：在线好友按 `worldId` 分组（同房间），分组标题“世界名 · 人数”，仅网页在线/未指定位置独立分组（`renderFriendGroups` + `.worldgroup/.wg-label` 样式）
- **web-design-guidelines 无障碍审查（P1/P2 已修复）**：3 个关闭按钮加 aria-label、搜索框（侧栏+搜索页）加 aria-label、toast 加 aria-live="polite" role="status"、输入框/按钮补 :focus-visible 焦点环（替代 outline:0）
- **P3 增强（全部完成）**：① URL 反映状态——视图/过滤同步到 `location.hash`（`syncHash()`/`_vmap`，刷新保持当前页）；② 字体 preconnect——HTML head 加 `rel="preconnect"`（fonts.googleapis.com + fonts.gstatic.com crossorigin，@import 已含 display=swap）；③ 键盘支持——事件行/好友行补 role="button" + tabindex + Enter/Space 键触发；④ `text-wrap:balance` 标题 + 时间/数字列 `font-variant-numeric:tabular-nums`
- **util.js 单元测试（8 个测试 33 断言）**：`test/dashboard-util.test.mjs` 固化标准值——信任等级颜色（VRCX presets）、在线状态色、仅网页在线判定、世界名标签（含“未知世界”/“未公开位置”规则）、实例位置解析、HTML 转义、事件类型 class、通知类型标签；`package.json` 加 `"test": "node --test \"test/*.test.mjs\""`，本地（Node 26）与容器（Node 22）双端 8/8 通过
- **VRCX 风格视觉精修（frontend-dev 不适用，已改为精修轮）**：自定义细滚动条（::-webkit-scrollbar 深色主题）、brandmark 阴影、表头半透明、导航/过滤/事件行按压态（translateY/active 背景）、世界分组背景微调、搜索框过渡动效
- **事件展开详情增强（VRCX GPS 式）**：展开详情加 来源（WebSocket/API）、完整时间（date+time）、世界行（世界名 + 复制世界 ID 按钮）；保留位置前→后/传送中/邀请/实例类型+区域+实例ID+复制
- **滚动条兼容说明**：webkit + 标准 scrollbar-width/color + 全局覆盖均已加；Edge 在 Windows 11 overlay 滚动条模式下忽略滚动条 CSS（手机/微信已生效），需系统关闭“自动隐藏滚动条”
- **收藏世界按收藏夹切换 UI 细化**：收藏夹名友好映射（worlds1→收藏夹 1…4）；按收藏夹模式加切换 tab（全部 + 各夹，`state.favGroup` 过滤，切回按类别时清空过滤）
- **接口回归探针**：`scripts/dashboard-probe.mjs` 一键验证 16 个端点（页面/首页/概览/好友/事件+分页/图表/搜索/四类收藏/模型/屏蔽/通知/世界记录），输出状态/耗时/数据大小/JSON；容器内实跑 PASS 16/16 FAIL 0
- **右侧栏好友点击修复（真实 bug）**：右侧栏 `.friend` 原无 onclick 绑定（点击无效），现 `renderFriendGroups` 末尾绑定 openUser + `cursor:pointer`；已审计 data-copy/通知按钮/搜索等绑定完整
- **收藏世界 stale-while-revalidate**：`favorites?type=worlds` 有旧缓存先秒回 + 后台刷新（避免冷缓存 7s+ 干等），抽 `loadFavoriteWorlds` 供路由与后台刷新共用
- **世界记录页点击修复（真实 bug）**：`loadWorlds` “好友世界记录”行的 data-user 原未绑定（点击无效）→ 绑定 openUser + 防双弹窗（行内 data-world 点击不冒泡到 openUser）；已审计搜索/收藏/通知/复制/首页绑定完整
- **浏览器标签标题跟随视图**：切视图时 `document.title` 同步（如 “VRChat Assistant · 我的模型”）
- **通知“全部已读”**：后端 `POST /api/dashboard/notifications/see-all`（VRChat 无批量端点，用 see_notification 逐个标记，cap 15 条防拖慢限流）；前端通知页工具栏加“全部已读”按钮（confirm + toast 结果 + 清缓存刷新）
- **世界详情增强（VRCX 对齐）**：`dashboard.world` 服务 pick 扩展完整字段（tags/featured/releaseStatus/capacity/visits/favorites/createdAt/updatedAt/performance），缓存含标签才视为完整否则限流器补齐；前端 openWorld 展示 统计（发布/容量/访问/收藏/性能/创建）+ 标签 chips + 特色徽章
- **好友位置页按世界分组（VRCX 对齐）**：friends 视图在线好友按 worldId 分组（世界名 · 人数），仅网页在线/离线独立分组，无好友时显示空态
- **资料页 Avatar 变更增强（VRCX 对齐）**：资料页“Avatar / 头像变更”tab 每条变更显示 模型名 + 新旧缩略图对比（`change.avatarThumbnailUrl`/`previousAvatarImageUrl`，点击放大预览）
- **首页 favoriteFriends stale-while-revalidate**：`get_favorite_friends_locations`（10+ 限流请求，首页慢根源）缓存过期时秒回旧数据 + 后台刷新，避免首页 7.8s 干等
- **收藏 Avatar 卡片增强**：卡片显示 发布状态/版本 + 作者名（`authorName`）
- **搜索体验增强**：进入搜索视图自动聚焦输入框（可直接打字回车搜索）
- **资料页同屏统计（VRCX 一起玩对齐）**：后端新增 `GET /api/dashboard/pair-screen?userId=&days=`（当前用户 + 目标好友调 `get_friend_pair_screen`，返回 matchCount/totalMinutes/worlds）；资料页“近期活动”tab 顶部显示「📊 最近 30 天同屏 N 次 · 共 X 小时 · 世界名」（`fmtMin` 格式化时长，无同屏记录不显示）
- **收藏世界加载优化（对齐上游 #100）**：`loadFavoriteWorlds` 删掉冗余的 `/favorites?type=world` 请求（上游 `get_my_favorite_worlds` 已一次拉全 `/worlds/favorites` 并返回 favoriteGroup/worldName/imageUrl）——冷拉由两次限流请求串行变一次；实测：缓存命中 78ms、冷拉 3s（110 个收藏世界）、上游优化前需 15-20 分钟
- **视图切换 token 修复（真实 bug，收藏页卡半天根因）**：`loadFavorites/loadNotifications/loadSearch/loadStats` 的 onclick 无参调用 → 函数内 `token!==viewToken` 恒真 → return 不渲染（永远"加载中"）。统一改为 `loadXxx(viewToken)`（6+4+2+1 处）
- **删除收藏分组页**：收藏页 tab 去掉"收藏分组"（按收藏夹 worlds1-4 切换已覆盖显示）；搜索页 groups 类型保留
- **收藏页重命名与删收藏模型**：侧栏/右侧栏/视图名"收藏&星标"→"收藏"；收藏页删除"收藏 Avatar"tab（我的模型页已有收藏模型），收藏页直接显示收藏世界（按类别/按收藏夹切换保留）
- **删除顶栏"实时事件记录"副标题**：`<small id="viewSub">` 已删（每页顶栏只剩视图标题 + 刷新按钮）
- **离线好友状态点强制灰色**：`friendRow`/`friendList` 离线好友 `statusDot` 用 offline（灰）——修复离线但 status 字段残留旧值导致绿/彩色点的问题；离线文字统一"离线"
- **信任等级从 tags 推断（对齐 VRCX）**：VRChat 对部分用户不返回 `trustLevel` 字段，但 `tags` 有 `system_trust_*`。对齐 VRCX `computeTrustLevel`（veteran→Trusted User/trusted→Known User/known→User/basic→New User），补全任务从 tags 推断写入；13 好友全部有等级
- **网页在线判定修正（对齐 VRCX）**：旧判定把 `location=offline`/`worldId=private` 当网页在线（误判游戏内用户）。修正：仅 `platform='web'` 判网页在线（VRChat API 语义）
- **PlayerList 房间玩家列表**：后端 `GET /api/dashboard/player-list`（服务账号实例信息 + 同房在线好友）；前端 players 视图（世界封面/实例人数平台/同房好友）。**诚实限制**：VRChat API 不暴露非好友玩家（VRCX 靠 Photon 抓包），服务器端仅好友可见
- **GameLog 游戏日志**：后端 `dashboard.gameSessions` 服务 + `GET /api/dashboard/game-sessions`（user-location 聚合会话）；前端 logs 视图（会话数/总时长/会话时间线）。实测：最近 7 天 72 会话/785 分钟
- **请求加入（VRCX 邀请对齐）**：后端 `POST /api/dashboard/invite-request`（request_invite 工具）；资料弹窗给在线好友显示「请求加入」按钮（toast 反馈）
- **快速搜索 Ctrl+K（VRCX Quick Search 对齐）**：任意页面按 Ctrl+K/Cmd+K 弹出快速搜索覆盖层，输入即时匹配本地好友 + VRChat 用户搜索（防抖 300ms），点击打开资料；Esc 关闭
- **状态预设（VRCX Social Status Presets 对齐）**：右侧栏状态预设（在线/加入我/问我/忙碌）+ 状态描述输入；`POST /api/dashboard/status`（PUT /auth/user/status）
- **VRChat 服务器状态指示（受限）**：状态栏 `#vrcs` 显示 VRChat 服务器状态（`GET /api/dashboard/vrc-status`，status.vrchat.com）。**诚实限制**：路由器无法访问 status.vrchat.com（被墙/不可达），VRChat API 无替代公开端点——接口保留，失败时显示 VRC —
- **好友备注全局显示（VRCX 对齐）**：`GET /api/dashboard/nicknames-all` 加载全部备注到 `state.nicknameMap`，`nameFor` 优先用备注名替换显示名（好友列表/事件流/资料统一显示备注名）
- **Tools 快捷工具页**：世界/模型/用户/群组 ID → 生成 VRChat 链接（可打开/复制）
- **通知操作对齐 VRCX**：好友请求接受/拒绝（`POST /api/dashboard/notifications/respond`，accept/decline + confirm）；**邀请通知接受/拒绝**（`POST /api/dashboard/notifications/invite-response`，PUT /invite/{id}/response）——通知页可完整处理社交请求

## 2026-08 第二轮改造（用户要求对齐 VRCX 重做）

- **游戏日志 1 分钟 bug 修复**：根因是 SQL `world_id != ''` 过滤了离开事件（traveling/offline 的 world_id 为空），同世界停留无结束标记 → 时长 1 分钟。改为**用 location 切分**：进入 wrld 开段、offline 结束段、traveling 传送中不切分（同世界传送合并）。实测：1 分钟段 52→9，7 天总时长 2371→6995 分钟（116 小时，合理）
- **删除首页**：侧栏/render/默认视图均移除（用户嫌写得烂），默认视图改为好友动态
- **图表参照 VRCX 重做**：新增 `dashboard.activityHeatmap` 服务 + `GET /api/dashboard/activity-heatmap`（从 user-location 推断在线时段，构建每天 24 小时在线热图，对齐 VRCX InstanceActivity）；图表页顶部显示在线热图（UTC 小时），保留每日活动/时段/类型/活跃好友 Top
- **好友动态增强**：筛选补全「模型」（friend-update-avatar）和「简介」（friend-update-bio）子筛选（对齐 VRCX Feed 的 Avatar/Bio 筛选）
- **通知完全重做（对齐 VRCX）**：通知行加发送者头像（从好友表匹配）；操作按钮按类型全补——friendRequest 接受/拒绝、invite 接受/拒绝、requestInvite 接受/拒绝（PUT /invite/{id}/response）、groupInvite 接受（`POST /api/dashboard/notifications/group-join` → /groups/{id}/join）/拒绝

## 2026-08 第三轮修复（用户反馈 4 项）

- **通知 UI 完全重做（VRCX 风格）**：分类筛选（全部/好友/群组/其他，对齐 VRCX getNotificationCategory）+ 按时间分组（今天/昨天/更早）+ 紧凑布局（头像/类型徽标/正文 .ni-body）+ 类型标签补全 VRChat 新格式（group.invite/group.announcement/group.event.*/moderation.warning 等）
- **热力图显示**：逻辑/接口/CSS 全验证正确（7 行 24 格、数据正常、CSS 注入）；加固 loadStats（stats/heatmap 双 catch 防单接口失败挂整个图表页）。**诚实**：系统无浏览器无法截图，需用户硬刷新确认
- **更换模型显示模型名（VRCX 对齐）**：根因是 WebSocket 推送无 currentAvatar/currentAvatarName（事件 avatarName 恒空）。**方案**：从 avatarImageUrl 的 file ID 查 `/file/{id}`，file.name 形如 `"Avatar - 模型名 - Image - ..."`，正则解析模型名 + 内存缓存。实测返回 Oiiai Oiiai Cat / 你的胆子真是肥嘟嘟的 / Marycia。**诚实限制**：事件无 avtr_xxx ID（推送不含），ID 无法补，名字已显示
- **加载更多无效**：根因是 30s 定时 `load()` 重置 `state.feedEvents` 回 50 条（用户加载的更多被清）。修复：`if(state.feedEvents.length<=50)` 才重置——加载更多后保留已加载分页

## 2026-08 第四轮（VRCX UI 差距对齐）

- **世界封面缩略图**：events 服务 SQL 加 `world_cache.image_url` → 前端 eventRow 世界列显示世界封面缩略图（.wthumb，点击打开世界详情）。实测 friend-location 事件封面返回正常
- **群组标签（VRCX grouphint）**：events 服务返回 `groupName`（事件 content 群组名），前端 world 列显示群组标签（.grp-chip）——有群组实例的事件显示
- **玩家列状态点**：eventRow 玩家列加状态点（对齐 VRCX player 列）
- **点击打开**：`openWorld`（世界详情弹窗）/`openUser`（用户资料弹窗）确认存在且 render() 绑定正常（点击世界→世界详情、点击玩家→用户资料、点击事件行→展开详情）

## 2026-08 第五轮（通知前端按 skill 重做）

用 `frontend-design` skill 方法重做通知前端（设计计划先行：VRChat 社交通知台主题 / 类型霓虹色 / mono 时间 / 头像+封面质感 / 类型彩色侧边条为标志元素）+ `web-design-guidelines` 审查（键盘可达/焦点可见/表单标签/空态/对比度，指南源因网络拉取失败按通用原则手动审查）。

- **工具栏**：分类筛选（全部/好友/群组/其他）+ **搜索框**（按发送者/消息实时过滤，VRCX 对齐）+ 全部已读
- **通知行**：**类型彩色侧边条**（好友橙/邀请蓝/消息绿/戳戳粉/投票红/群组紫）+ 发送者头像或群组图标 ◈ + 名字（**点击打开玩家资料**，Enter/Space 键盘可达 + `:focus-visible`）+ 类型徽标 + **世界封面块**（invite 点击打开世界详情）+ 消息 + mono 时间 + 按类型操作按钮（接受/拒绝等）
- **分组**：今天 / 昨天 / 更早（VRCX 时间线）
- **空态文案**：邀请行动式（"好友请求、房间邀请、群组动态会出现在这里"）
- **无障碍**：搜索框 `aria-label`、发送者可聚焦、对比度检查

## 2026-08 Vue 3 迁移（阶段 1：基础设施 + 框架组件化）

用户要求迁移 Vue/React。选型 **Vue 3**（对齐 VRCX 新架构，模板迁移平滑）。**无构建方案**：`vue.global.prod.js`（3.5.41）本地 vendor 托管（`/dashboard/vendor/vue.global.prod.js`，缓存 1 天），浏览器编译 template。

- **阶段 1（本轮）**：Vue 基础设施打通 + 框架组件化——侧栏导航（`SideNav` 组件，点击调 `window.__renderView` 复用旧 render）+ 状态预设（`StatusPresets` 组件，调 `window.applyStatus`）；`app.js` 暴露 `window.__renderView`/`window.__state`、删除侧栏 data-view 绑定；`dashboard.html` 加 `#vueNav`/`#vuePresets` 挂载点 + vendor 引入
- **视图渲染暂用现有数据函数**（Vue 壳 + 旧 render 共存，功能 100% 保留），**阶段 2+**：逐个视图组件化（好友动态 → 好友位置 → 弹窗 → 其余）
- **验证**：vendor 路由 200、页面含 createApp/vueNav/vuePresets、拼接 JS OK、`npm test` 7/7、容器 healthy

## 2026-08 Vue 3 迁移（阶段 3：好友动态视图 Vue 化）

用户追加标准：随时翻阅 VRCX 代码学习借鉴。参考 VRCX `Feed.vue`（DataTableLayout + 类型筛选 Popover + 列：expander/日期/类型 Badge/玩家/detail）。

- **FeedView Vue 组件**（`client/js/vue/views.js`）：类型筛选（全部/☆/位置/上线/下线/资料/状态/模型/简介，对齐 VRCX feedFilterTypes）+ 事件行（时间/类型 Badge/玩家/详情/世界封面+群组+实例）+ 展开详情 + 加载更多；复用 util/views 渲染函数（time/eventType/nameFor/eventDetailLine/eventExpanded 等）
- **render() 接管**：`view==='feed'` 时隐藏旧 #mainContent、显示 `#vueMain`（Vue FeedView 渲染），其他视图仍由旧 render 管理
- **注入**：`__DASHBOARD_VIEWS_JS__` → `vue/views.js`；dashboard.html 加 `#vueMain` + views 脚本标签；views.js 暴露 `window.__labels`
- **验证**：容器 feed/renderTakeover/vueMain/viewsTag 全 true、部署 healthy

## 2026-08 Vue 3 迁移（阶段 4：好友位置视图 Vue 化 + MainView 视图路由）

参考 VRCX `FriendsLocations.vue`（segmentedOptions Tab 分段 + 按实例/群组分组 + InputGroupSearch 搜索 + FriendCard）。

- **MainView 根组件**：按 `store.view` 切换 FeedView / FriendsView（`#vueMain` 挂载一个 Vue 应用）
- **FriendsView**：Tab（全部/同实例/收藏）+ 搜索好友 + 按世界实例分组（世界名 + 人数，>1 同房合并）+ 仅网页在线/离线分组 + 好友行（头像/信任色名字/状态/世界/实例类型）
- **app.js**：`__renderView` 设 `store.view`（Vue 响应式视图切换）；`render()` feed/friends 都由 Vue 接管
- **验证**：容器 main/friends/store/tabs 全 true、部署 healthy

## 2026-08 Vue 3 迁移（阶段 5：资料弹窗 UserDialog Vue 化）

参考 VRCX `UserDialog.vue`（TabsUnderline 导航：Info/Activity/Groups 等）+ `userCoordinator`。

- **UserDialog Vue 组件**（`#vueDialog` 挂载）：header（名字）+ TabsUnderline（资料/活动/同屏/资料变化/群组）+ 内容区
- **profile tab**：复用 `profileHeader`/`profileFacts`（纯函数，v-html）
- **活动/同屏/资料变化/群组 tab**：Vue 调 API（friend-events/pair-screen/profile-changes/groups）+ Vue 渲染
- **openUser 改造**：设 `store.selected` → Vue 弹窗显示（Escape 关闭 Vue 弹窗）
- **验证**：容器 dialog/openUser/vueDialog 全 true、部署 healthy

## 2026-08 Vue 3 迁移（阶段 6：右侧栏 RightBar Vue 化）

参考 VRCX FriendList 卡片（头像/名字/状态/世界/实例）+ FriendLocations 分组。

- **RightBar Vue 组件**（`#vueRight` 挂载）：好友计数 + 搜索 + 在线好友按世界实例分组（世界名 + 人数 + 网页在线组）+ 收藏 + 离线 + 点击打开用户
- **core.js**：挂载后启动 `window.__load()` + 30s 轮询（Vue store 数据驱动）
- **dashboard.html**：右侧栏 → `#vueRight`（保留 `#vuePresets` 状态预设 + sidefoot）
- **app.js**：删 `renderFriendGroups()` 调用 + `#friendSearch` 绑定
- **过程事故**：friendSearch 删除误删 `applyStatus` 开头（语法错误）→ 已修复（恢复 applyStatus + 删多余 `});`）
- **验证**：容器 right/apply/vueRight 全 true、部署 healthy、`npm test` 7/7

## 2026-08 Vue 3 迁移（阶段 7：世界/模型/群组弹窗 Vue 化）

参考 VRCX `WorldDialog.vue`（封面+作者+统计+标签+简介）、`AvatarDialog.vue`、`GroupDialog.vue`。

- **DialogRoot**（`#vueDialog` 挂载）：渲染 UserDialog/WorldDialog/AvatarDialog/GroupDialog 四个弹窗组件
- **WorldDialog**：封面大图 + 名字 + 作者 + 统计（发布/容量/访问/收藏/性能/创建）+ 标签 + 简介 + 复制 ID
- **AvatarDialog**：模型图 + 名字 + 作者/版本/Unity + 标签 + 简介 + 复制 ID
- **GroupDialog**：群组封面 + 名字 + 邀请码 + 成员/加入设置统计 + 简介 + 复制 ID
- **openWorld/openAvatar/openGroup** 设 `store.worldModal/avatarModal/groupModal` → Vue 弹窗接管
- **验证**：容器 root/four/ow/store 全 true、部署 healthy

## 2026-08 Vue 3 迁移（阶段 8：图表视图 ChartsView Vue 化）

参考 VRCX `Charts`（InstanceActivity 热图 + HotWorlds/MutualFriends）。

- **ChartsView**：近 7/14/30 天切换 + KPI（在线/事件/活跃天数）+ **在线热图**（24h × 天网格，对齐 VRCX InstanceActivity）+ 每日活动量 + 时段分布（chips）
- **MainView** 加 charts 分支；`render()` charts 由 Vue 接管
- **验证**：ChartsView/热图/__chartsView 确认、容器 healthy、`npm test` 7/7

## 2026-08 Vue 3 迁移（阶段 9：搜索/收藏/世界记录视图 Vue 化）

参考 VRCX `Search.vue`（搜索框 + 类型 + 结果）、`Favorites`（收藏世界/好友）。

- **SearchView**：搜索框 + 类型 tab（用户/世界/群组）+ 结果列表 + 无关键词时显示最近访问世界（带封面卡片）
- **FavoritesView**：收藏世界卡片（封面 + 人数）+ 收藏好友列表
- **WorldsView**：最近访问世界卡片网格（封面 + 访问次数 + 日期）
- **MainView** 6 视图分支；`render()` 用 isVueView 列表接管
- **过程事故**：`return` 后缺分号致语法错误 → 已修复（`return;`）
- **验证**：容器 search/fav/worlds/render 全 true、部署 healthy、`npm test` 7/7

## 2026-08 Vue 3 迁移（阶段 10：玩家/日志视图 Vue 化）

参考 VRCX `PlayerList.vue`（实例 header + 玩家表）、`GameLog.vue`（会话列表 + 时长）。

- **PlayersView**：当前实例世界 header（世界名 + 封面 + 实例 + 人数）+ 同房在线好友列表（点击打开用户）
- **LogsView**：游戏会话列表（近 7/14/30 天切换 + 世界名 + 时长小时数 + 会话总数/总时长）
- **MainView** 8 视图分支；`render()` isVueView 接管 players/logs
- **验证**：PlayersView/LogsView/MainView8/render 全 true、容器 healthy、`npm test` 7/7

## 2026-08 Vue 3 迁移（阶段 11：全部 12 视图 Vue 化完成）

参考 VRCX `MyAvatars.vue`（网格 + 缩略图）、`Moderation.vue`（屏蔽列表 + 操作）、`Tools.vue`。

- **AvatarsView**：我的模型网格（缩略图 + 公开/私有 + 版本，点击打开模型弹窗）
- **ModerationView**：屏蔽/静音列表 + 解除操作（POST unblock）
- **ToolsView**：VRChat 链接生成器（世界/模型/用户/群组 ID → 链接）
- **OpenView**：直接打开（粘贴链接/ID 识别 wrld_/avtr_/usr_/grp_）
- **MainView 全部 12 视图分支**；`render()` isVueView 接管全部视图（旧视图渲染分支全部退役/不可达）
- core.js 暴露 `window.__toastMsg`
- **验证**：容器 views/route/render/dialogs/frame 全 true、部署 healthy、`npm test` 7/7
- **Vue 化最终架构**：`vue/core.js`（数据层+框架）+ `vue/views.js`（12 视图+MainView）+ `vue/dialogs.js`（4 弹窗+DialogRoot）+ `vue/rightbar.js`（右侧栏）

## 2026-08 Vue 3 迁移（阶段 12：Feed 日期范围筛选）

参考 VRCX `Feed.vue`（RangeCalendar 日期过滤 + 类型筛选双维度）。

- **FeedView 日期筛选**：类型筛选 + 日期范围（全部时间/今天/昨天/近7天）组合过滤，`rows` computed 双维度过滤 + `.filters-sep` 分隔
- **验证**：容器 df/startOf true、部署 healthy、`npm test` 7/7

## 2026-08 Vue 化故障修复（用户反馈：页面显示旧版、组件缺失）

用户反馈 Dashboard 显示旧好友动态栏、其他组件没了。**根因排查**（路由器宿主机装 chromium headless + CDP 实测）：
- **页面 HTML 正确**（4 内联 script、挂载点全在、Vue 库内联）
- **CDP 捕获异常**：`ReferenceError: Cannot access 'toast' before initialization` —— core.js 中 `window.__toastMsg = toast` 写在 `const toast` 定义**之前**（TDZ），导致 core.js IIFE 中断 → SideNav/StatusPresets/QuickSearch/30s 轮询全部未执行 → 只剩 views.js 的 MainView（FeedView）渲染主区
- **修复**：`__toastMsg` 赋值移到 `toast` 定义之后
- **验证方法沉淀**：容器 apt 装 chromium + `--dump-dom`/CDP 实测渲染与 JS 错误（注意：docker rebuild 会丢容器内 apt 包，需重装）

## 2026-08 三问题修复（状态栏 / 点不开详情 / 右侧好友面板 VRCX 对齐）

1. **状态栏（AUTH/WS/DB 就一个破折号）**：Vue 化后旧 `load()` 不再轮询 → `#auth/#ws/#db` 无更新源。修复：core.js 的 30s 轮询补 `upd('#auth'/'#ws'/'#db')`（overview 数据）
2. **点世界/点好友点不开详情**：根因 = 前述 toast TDZ（core.js 中断 → 弹窗未挂载）。toast 修复后 jsdom 实测：sideNav 11 / mainContent 742 / presets 5 / userDialog 2 / errors []——侧栏、主区、状态预设、弹窗全部挂载且响应
3. **右侧好友面板 VRCX 对齐**（参考 VRCX FriendList columns + 官方状态色）：
   - 条目改为**状态描述（fs-desc）+ 位置/实例（fs-loc）分行**（VRCX statusDescription + location 列）
   - **ask me 状态色对齐 VRCX 官方橙 #e97c03**（原为黄色）
   - 保留信任色名字 + 状态点 + 按世界实例分组
- **验证**：状态栏/toast 修正/RightBar VRCX 全 true、`npm test` 7/7、容器 healthy

## 2026-08 以容器版（另 agent 直接改路由器）为准 + 修复

用户确认：另一个 agent（nixi-agent）直接在路由器容器内改文件（不在 git commit）。md5 对比定位：
- **另 agent 重写/新增**：`vue/app.js`（RootApp 单一根挂载整个 VRCX 界面，13 视图含 NotificationsView 通知页）、`vue/views.js`（1046 行 13 视图）、`vue/core.js`（277 行完整数据层）、`vue/rightbar.js`（167 行+图片代理降级）、`vue/dialogs.js`（878 行）、`server/routes/image-proxy.js`（VRChat 图片代理加速）、`dashboard.css`（38KB 新布局类 app-header/nav-rail/main-viewport/rightbar）、`index.js`/`dashboard.html`（7 script 纯 Vue 注入）
- **同步容器版回本地**（8 文件，CRLF→LF）并以它为准
- **修复（jsdom 实测发现）**：
  1. **WorldDialog 缺失 bug**（另 agent 的 dialogs.js line 871 引用 WorldDialog 但未定义 → `<WorldDialog/>` ReferenceError，世界详情打不开）——已补 WorldDialog 组件（封面/统计/标签/简介，容器版 modal 类名）
  2. **底部状态栏**（AUTH/WS/DB/VRC）——容器版无底部状态栏（只有 header SSE badge），用户此前反馈状态栏需显示——已补 `.app-footer`（app.js 模板 + dashboard.css）+ core.js store authStatus/wsStatus/dbStatus + load() 从 overview 更新
- **jsdom 实测**：header/navRail 11/mainViewport/footer（AUTH/WS/SSE/DB/VRC 文本）/rightbar/modals 2/errors []
- **验证**：状态栏/footer/WorldDialog 全 true、`npm test` 7/7、容器 healthy

## 2026-08 弹窗样式修复（另 agent 类名与 CSS 不匹配）

用户反馈：弹窗不是弹窗（在页面底部）、样式不美观。

**根因**：另 agent 的 `dialogs.js` 用 `.modal-mask`/`.modal`/`.icon-btn`/`.modalprofile`/`.worldmodal-cover` 等类名，但容器版 `dashboard.css` 定义的是 `.modal-backdrop`/`.modal-card`/`.modal-close-btn` 体系——**类名不匹配 → 弹窗无 `position:fixed` 定位，在页面底部流式显示**。

**修复**：补齐 dialogs.js 用到但 CSS 缺失的 **28 个类**（对齐容器版弹窗体系与变量）：
- 弹窗框架：`.modal-mask`（fixed 全屏遮罩+flex 居中）/`.modal`（圆角卡片+阴影）/`.modal-head`/`.modal-title`/`.icon-btn`/`.modal-body`
- 内容排版：`.modalprofile`/`.modaldesc`/`.modalsection`/`.facts`/`.fact`/`.worldmodal-cover`/`.uph-avatar`/`.uid-text`/`.json-box`/`.history-list`/`.hl-*`
- 工具类：`.error`/`.text-muted`/`.text-xs`/`.mb-3`/`.mt-2`/`.mt-3`

**验证**：弹窗 CSS 全 true、`npm test` 7/7、容器 healthy + 容器 CSS 含 modal-mask/modalprofile/worldmodal-cover

## 2026-08 右侧栏 VRCX 对齐（同实例好友分组 + 我条目）

参考 VRCX `FriendsSidebar.vue`（me-item 置顶 + friendsInSameInstance 分组 + 收藏/在线/离线分段）。

- **后端**：新增 `GET /api/dashboard/me`（复用 avatars.js 的 5min `/auth/user` 缓存，导出 `loadMe`），返回 userId/displayName/location/travelingToLocation/status/statusDescription/avatarUrl/trustLevel/currentAvatar/**currentAvatarName**。模型名解析：`/auth/user` 只给 currentAvatar(ID)，按 ID 查 `/avatars/{id}` 拿精确名字（`loadAvatarName`，复用 avatars.js 30min 详情缓存 + stale-while-revalidate）；实测返回当前账号模型 "Sunohara Kokona"
- **前端 core.js**：store 加 `me`，`load()` 并行拉 `/api/dashboard/me`
- **前端 rightbar.js**：
  - **me-item 置顶**：当前用户头像 + 信任色名字 + 状态点 + 状态描述 + 实例位置（点击打开自己资料；空 location 时显示状态描述如“挂机”而非“离线”）
  - **同实例好友分组**：与我在同一世界实例的在线好友（`location === me.location` 精确匹配，同 player-list 判定）置顶高亮（accent 边框/图标/加粗），并从普通世界分组排除避免重复
  - 搜索/收藏/离线/状态预设逻辑不变
- **CSS**：`.me-item`（卡片式）+ `.worldgroup.same-instance`（accent 高亮，color-mix 背景）
- **验证**：jsdom 实测（无 JS 错误、me-item 渲染「我自己」、同实例分组 2 人 + 世界名、空 location 显示状态描述、普通分组保留非同实例好友）；`npm test` 7/7；mock register 38 路由无重复；部署路由器 healthy；容器内 `/api/dashboard/me` 实拉返回当前账号/挂机/currentAvatar 正常；rightbar.js md5 容器=本地一致
- **诚实限制**：用户当前 location 为空（在线但不在世界）→ 同实例分组实际不显示；进入世界后自动出现。浏览器视觉复验因容器 rebuild 丢失 chromium 且路由器 apt 安装过慢，本轮跳过（jsdom + 端点已覆盖渲染逻辑与数据）

## 2026-08 重启后页面加载慢（冷缓存 + 限流排队）修复

用户反馈：每次重启容器后，动态等页面要过很久才刷新出信息。

**实测定位**：路由器冷库 curl 计时——`events` 端点 **115.6s**（其余全快）。根因：① events 服务里模型名解析（`/file/{id}`，冷缓存 anCache 为空）是**同步 await**，每个请求走限流器 2.6s + 路由器到 VRChat API 往返延迟大（实测单次 API ~16-23s），6 个调用轻松 1 分钟+，直接阻塞动态流响应；② 前端 `load()` 用 `Promise.all` 等全部 6 个端点（含 favorites/me 这类 API 冷库请求）才渲染，动态流被无关请求卡住。

**修复**：
- **后端 events 非阻塞 + 持久化**：模型名解析改为命中缓存立即填、未命中丢**后台**限流补（本次响应立即返回 DB 数据）；anCache 落盘 `planet_cache`（key `avatar_name:{fileId}`，重启载入不再重查）。实测：events 冷库 **115.6s → 0.021s**，第二轮 0.02s；planet_cache 已持久化 5 个真实模型名
- **前端 load() 拆分**：关键路径（overview/friends/events，全本地 DB）先渲染，收藏好友/备注/我（VRChat API）放 `Promise.allSettled` 后台填——动态流/首屏不被 API 排队阻塞，侧栏数据随后到位
- **验证**：jsdom 全绿、`npm test` 7/7、语法检查通过、部署 healthy、md5 容器=本地、重启后 events 毫秒级
- **诚实限制**：favorites/me 单次 API 冷库仍 ~16-23s（路由器到 VRChat 网络固有延迟，无法消除），但已不阻塞首屏且会缓存；收藏/我的模型等按需 API 视图冷库仍显示「加载中」（一直如此）

## 2026-08 UI 架构升级：Vite + PrimeVue 全面重写（双端）启动

用户选定 **PrimeVue 4 + Vite 构建**，允许全面重写前端（保留后端 API 与信息架构），目标桌面+移动双端。

**关键决策**：
- 构建在本地跑（路由器只发产物，Dockerfile `COPY . .` 直接带 `ui/dist`）；`vite-plugin-singlefile` 把所有 JS/CSS 打进一个 index.html（~1.06MB）→ `/dashboard` 仍是单文件请求，**无需静态资源鉴权白名单**（PrimeIcons 的 woff2/woff/eot 已内联，仅 SVG 因 `?#primeicons` 片段留在外部但现代浏览器走 woff2 不会请求，已从 dist 删除）
- 认证不变：`?token=`/Header 鉴权；`/dashboard?legacy=1` 回退旧版 UI

**里程碑 1 已部署（plugins/official/web-dashboard/ui/）**：
- `src/main.js` — PrimeVue 4.5 + Aura 主题 + 自定义 violet 主色（`definePreset`）+ 按需注册组件（Tree-shaking）
- `src/store.js` / `src/api.js` / `src/utils.js` — 数据层（沿用快/慢路径拆分、30s 轮询、SSE、hash 视图同步）
- `src/App.vue` — 响应式壳：顶栏(品牌/搜索 pill/SSE/刷新)、左导航 rail、主视口、右侧好友栏、底部状态栏；移动端(<900px)底部 Tabbar(动态/好友/通知/收藏/更多) + Drawer 全导航
- `src/views/FeedView.vue` — 动态流：类型筛选(SelectButton)+日期筛选+搜索+事件行(时间/类型Tag/玩家/详情/世界封面链接)+展开详情(复制 ID)+加载更多；移动端卡片化
- `src/views/FriendsView.vue` — 好友位置：全部/同实例/收藏 Tab+搜索+世界分组卡片+离线
- `src/components/RightBar.vue` — me-item(状态+模型名)+同实例高亮分组+在线按世界+收藏+离线+状态预设
- `src/components/UserDialog.vue` — 资料/活动/同屏/资料变化 四 Tab（调 friend-events/pair-screen/profile-changes）
- `src/components/WorldDialog.vue` / `QuickSearch.vue`（Ctrl+K）
- 未迁移视图显示 Placeholder（后续迭代逐个迁移）

**验证**：`vite build` 成功（328 模块）、store 数据层 Node 冒烟全绿（好友/动态/收藏/备注/我/同实例/加载更多/视图切换）、部署 healthy、`/dashboard` 200（1.06MB 含 PrimeVue 标记）、`?legacy=1` 200（旧版）、无 token 401。
**诚实限制**：浏览器视觉/交互验收需用户强刷确认（未用 chromium）；11 个视图还是占位；dist/ 未 commit（待用户确认是否入库）。

## 2026-08 好友动态页重写（用户详细规格 + VRCX Feed 对齐）

用户给定桌面端详细规格 + 移动端自定，对齐 VRCX `Feed.vue`（ToggleGroup 多选 + Star Toggle + 日期 Popover + GPS/Online/Offline/Status/Avatar/Bio 类型）。

**桌面端**：
- **顶部筛选**：日期（单按钮 → Popover 快速选项：全部/今天/昨天/近7天/近30天）、星标（单按钮 ★，仅显示收藏好友）、类型横条（所有/位置变动/上线/下线/状态变动/模型变动/简介变更，**多选**：点选/点取消，空=所有，与 VRCX handleFeedFilterChange 语义一致）、搜索框
- **表格**：列 = 时间 / 类型 / 玩家 / 详细信息（表头 sticky）
- **详细信息规则**：
  - 位置变动：`旧世界 → 新世界` + 实例类型·区域徽章 + 传送中/可请求邀请
  - 状态变动（friend-active + friend-update|status）：旧状态灯 → 新状态灯（VRChat 官方色 active绿/joinme蓝/askme橙/busy红/offline灰）；纯签名变动显示 `[状态灯] 当前签名`
  - 模型变动：新旧缩略图 + 模型名 + avtr ID（可复制）
  - 简介变更：当前简介
  - 上线：`进入 {世界名}`
- 行点击展开详情（事件编号/来源/完整时间/世界+复制/实例+复制/模型ID/状态与签名前后对比）
- **移动端**（自定）：筛选横条换行成 chips、搜索全宽；表格变卡片（时间+类型一行 / 玩家一行 / 详情一行）

**数据层确认（真实库）**：`friend-update|status` 带 previousStatus/previousStatusDescription；`friend-update|avatar` avatarName 已富化（/file 解析）但 **avtr ID 推送不含**（VRChat WS 限制，显示时 ID 有则展示可复制，无则只显示名字）；friend-active 无 previousStatus 只显示当前灯+签名。

**验证**：vite build 成功、store 回归通过、部署 healthy、`/dashboard` 新构建 1079KB（筛选文案/slamp/ft-head 全部在）、`?legacy=1` 仍可回退。
**诚实限制**：浏览器视觉/交互需用户强刷确认。

## 2026-08 动态页 6 项调整（配色/头像/可点击/实例标签/世界头图/模型ID排查）

用户反馈 6 点，全部处理：

1. **模型 ID 排查（诚实结论）**：用户问"WS 不给模型 id 能改接口吗"。实测：现代 VRChat API **已从 User 对象移除 `currentAvatar` 字段**——好友列表（offline=true，12/12 只有图片 URL 无 ID）、`/users/{id}?includeAvatar=true`（仍无）、WS friend-update（无）、`/avatars?userId={他人}`（403 "You can only browse your own avatars"）。**只有 `/auth/user`（自己）保留 currentAvatar**。VRCX Feed 源码（columns.jsx）确认：它模型详情显示的是**模型名 + 作者 ID + avatartags，没有 avtr ID**。结论：改接口也拿不到好友模型 ID，这是 VRChat API 层级限制。已做 best-effort：avimg 映射 + 事件富化逻辑保留（API 恢复字段即自动生效）；对齐 VRCX 显示 avatarTags chips。
2. **配色黑灰偏黑**：`--bg #070708`/surface `#0e0e10`/`#131315`/`#1a1a1d`（去蓝调），PrimeVue Aura dark surface 定制同色系
3. **玩家列头像**：根因 = 浏览器直连 api.vrchat.cloud 被墙（旧前端注册了 image-proxy 但从未接线）。新 UI 全部图片统一走 `/api/dashboard/image-proxy?url=&token=`（白名单域名 + 6h LRU 缓存），实测代理 200 image/png
4. **A→B 都可点击**：events 服务 `previousLocationOf` 补 worldId/imageUrl → 返回 `previousWorldId`/`previousWorldImageUrl`（实测 99/128 位置事件有）；前端 A、B 都渲染为 world-link 可点击开世界详情
5. **实例标签**：`instanceLabel()` 映射 public→Public / hidden→Private / friends→Friends / group→Group / local→Local；FeedView 徽章 + 展开详情 + locLabel 统一用
6. **世界头图**：事件 `worldImageUrl`/`previousWorldImageUrl` → 位置变动/上线详情世界名前显示 26px 缩略图（.wthumb，走代理）

**验证**：构建成功、部署 healthy、新构建含全部标记（070708/wthumb/av-tag/image-proxy/Private/previousWorldId）、image-proxy 实测 200。
**诚实限制**：浏览器视觉需用户强刷验收；模型 ID 好友侧无法获取（API 限制，见上）。

## 2026-08 头像首字母不显示 — 根因修复（PrimeVue Avatar label 优先级）

用户连续两轮反馈"头像没显示，只显示首字母"。前一轮已改直连优先+代理降级仍无效。

**根因**：翻 PrimeVue Avatar 源码确认渲染优先级为 **label > icon > image**——只要传了 `label` prop（首字母），组件**根本不会渲染 `<img>`**。此前所有 Avatar 都同时传 `:image` 和 `:label`，导致图片从不加载、永远显示首字母（与网络/代理无关）。

**修复**：新增 `avatarLabel(url, name)`（utils.js）——有 URL 返回 `undefined`（不传 label → 渲染图片），无 URL 返回首字母（兜底）。9 处 Avatar（FeedView 玩家列 / RightBar me+4分组 / FriendsView 3分组 / UserDialog header）全部改为条件 label。图片策略保持：直连优先 + 失败全局降级代理（main.js capture 捕获 img error）。

**验证**：avatarLabel 逻辑单测（有URL→undefined/无URL→首字母）✓、构建 ✓、部署 healthy ✓。
**教训**：PrimeVue 组件务必先查源码确认 prop 行为（Avatar 的 label/image 是互斥分支，不是"image 失败才显示 label"）。

## 2026-08 通知事件分类显示 + 搜索框重做

用户反馈：① not_xxx 通知事件显示成"资料变动"，应分类（好友申请/群组消息）；② 搜索框样式不好看。

**通知事件（后端）**：events 服务为 notification/notification-v2 补字段——`senderUserId/senderUsername/notiImageUrl/notiMessage/notiTitle/notiGroupName/notiGroupId`（群组名从 `data.groupName` 或 title 前缀提取）；summary 改为消息文本。真实数据结构：v1 `friendRequest/invite`（content.senderUserId/Username）、v2 `group.*`（data.groupName/groupId + imageUrl + message）。

**通知事件（前端）**：typeOf 细分 friendRequest/invite/message/group/notification；类型标签：好友申请/邀请/私信/群组/通知；玩家列——好友申请显示**发送者头像+名字**（按 senderUserId 从 friends 匹配），群组显示**群组头像+群组名**（点击开群组）；详情列——好友申请"X 请求加你为好友"、群组"群组名 + 消息内容"、邀请/私信显示消息；展开详情含发送者/群组/标题/内容；搜索过滤加通知字段。

**搜索框**：自研胶囊样式（28px 与 chips 同高、放大镜图标、聚焦紫边+光晕、有输入时显示清除按钮）。

**验证**：start-monitor 语法 OK、构建 OK、部署 healthy、events API 实测群组公告返回 notiGroupName=Trans + 群组图、构建含"好友申请"/noti-group/search-clear 标记。

## 2026-08-27 位置去重 + 房间类型排序

- **位置变动误报修复（根因）**：位置去重原用进程内存 Map（`_lastLocByUser`），容器重启即清空 → VRChat 换模型/重连重推的同位置事件（friend-location/user-location）被误记成"位置变动"。改为**持久化对比**：friend-location 对比 friends 表上次位置、user-location 对比 events 表上次位置（`json_extract content_json.location`）；位置没变只刷在线时间，模型变动仍正确记录。已清理 3489 + 72 条历史误记（备份 before-loc-dedup-fix.sqlite3；剩余 14 条跨日同位置保守保留）。
- **房间类型排序与术语（用户定稿）**：实例类型从高到低 **公开 > 好友+ > 仅限好友 > 邀请+ > 仅限邀请 > 群组房间**。`instanceLabel()` 全站术语对齐（Friends+→好友+、仅好友→仅限好友、Invite+→邀请+、邀请→仅限邀请、群组→群组房间）；群组内部再分 群组公开/群组+/群组成员（groupAccessType）；世界弹窗房间 tab 实例列表按 TYPE_ORDER+GROUP_ORDER 从高到低排序。后端 worldInstances 类型解析（public/friends+/friends/private/hidden/group + groupAccessType）此前已实测。

## 2026-08-27 UI 双端适配全轮（A1 / B1-7 / C1-5）

用户确认按顺序全修，逐项部署验证：

- **A1 移动端好友入口**（`00566a9`）：右侧好友栏原来 `v-if=!isMobile` 手机上完全不可达。新增 header 好友按钮 → 右侧 Drawer 嵌 RightBar（min(380px,94vw)），openUser 自动收起抽屉避免遮挡弹窗。
- **B1/B2/B3 动态页移动端**（`5691b52`）：① 类型筛选 chips 单行横向滚动（原全宽换行占半屏）；② 日历移动端单月 `numberOfMonths=isMobile?1:2`；③ 行点击展开详情（事件ID/完整时间/来源/世界/实例/模型/状态前后+复制，桌面移动一致）+ 移动端 chev 指示；后端 events 补 `source` 字段（websocket/poll）。
- **B4/5/6/7**（`16e4e20`）：④ fg-loc/wg-loc 分组头位置截断省略号（max-width 42%）；⑤ 全局 `.p-dialog-content max-height:calc(100dvh-130px)` 超高内部滚动；⑥ footer-brand 移动端隐藏；⑦ 移动端隐藏 UserDialog 头部完整 userId（信息页已有可复制）。
- **C1/C2/C3/C4/C5**（`a30e546`）：① 触屏目标加大（chip 32px/mp-btn/wg-head/friend-card padding+）；② 移动端字号提升；③ 移动端 header `safe-area-inset-top`（刘海屏）；④ 900-1280px 窄窗口收窄两侧栏（168/248px）；⑤ 新建 `composables/useFriendGroups.js` 抽公共（分组/折叠/签名/状态点/状态色），RightBar+FriendsView 共用，**顺带修正好友页离线有签名不显示的不一致**（现签名优先全站统一）。

**验证**：每轮构建+部署 healthy，dist 标记命中（friends-drawer/ev-detail/footer-brand/safe-area-inset-top/groupByWorld），events API source 字段返回正常。

- **微调轮**（`cd5c015`）：动态模型缩略图 34→26px 与世界图一致；右上角改「当前筛选 N · 已加载 N · 数据库 N 条」三段（title 含完整说明，移动端收窄省略）；右侧栏搜索框全端统一 36px（原桌面30/移动34分裂显矮）。
- **信用等级 VRCX 风格**（`3de0773`）：色值对齐 VRCX-Luo `appearance.js TRUST_COLOR_DEFAULTS`（veteran#B18FFF / trusted→Known#FF7B42 / known→User#2BCF5C / basic#1778FF / visitor#CCCCCC / vip#FF2626）；新增 `TrustBadge.vue`（描边徽章+盾牌图标+等级色，VRCX UserSummaryHeader 同款）用于用户弹窗头部；`trustName()` tags/旧推断值 → VRCX 英文名（system_trust_veteran→Trusted User、system_trust_trusted→Known User），修正此前推断显示 "Veteran" 的问题；好友列表名字颜色同步新色值。
- **UI 问题清单修复轮**（`89792fc`）：① store 所有 openXxx 移动端先收好友抽屉（修房间号/世界名点击被 Drawer 挡住）；② 移动端 bottom-center toast 上移 tabbar 高度（查 PrimeVue 主题源码确认无此处理）；③ 动态渲染上限移动端 200/桌面 400 + 封顶提示"更早内容请用日期筛选"（无虚拟滚动的性能保护，虚拟滚动按用户拍板不做）；④ 当前视图不在前四 tab 时移动端"更多"保持高亮；⑤ header 刷新按钮 loading 态防连点；⑥ iOS visualViewport 键盘高度 → --vvh 变量修 fixed 布局被顶飞。右键菜单与宽屏最大化利用明确不做（用户拍板）。
- **计数格式+状态页排版轮**（`9c71456`）：动态右上角改 `50/50/3181` 紧凑三段（title 含完整说明）；资料弹窗移动端信息项单列、标签列 min-width 对齐两列观感、行高加大；好友抽屉我卡片/状态按钮 2×2 大按钮排布 + 描述框加高。
- **移动端去最大化按钮**（`7e9e079`）：用户/世界/群组三个 Dialog `:maximizable="!store.isMobile"`，手机上不再显示最大化按钮（弹窗本来已 95vw 满宽，最大化无意义）。
- **资料弹窗头部瘦身**（`3a85906`）：头部移除 userId+复制按钮（PC+移动一致——信息页已有「玩家 ID」行可复制，用户指出头部冗余）；「正在使用的模型/展示群组」改单行省略不内断（title 存全名），长模型名不再把头部挤换行；头部右侧控件区整体收窄上提。
- **模型字段下沉+加载态**（`8381f84`）：「正在使用的模型」「展示群组」从头区移入信息页 facts 置顶两行（模型名点击可放大原图）；弹窗头部 loading 时只显示转圈（不再闪半截资料），profile 加载完一次性渲染头区+内容。
- **加载态修正轮**（`856d17e`）：正文 loading 圈与头部圈重复 → 去掉正文圈，头部只留**单个**转圈 + 删除「加载中…」文案；「展示群组」按用户要求移回头部（状态行下方，盾牌图标+单行省略+可点击开群组），信息页只保留「正在使用的模型」。
- **动态移动端精简**（`69e9d6b`）：移动端禁用行展开（toggleRow 早退、隐藏 chev、去手型/高亮）；日期筛选+星标按钮并入标题行（26px 小 chips），工具栏只剩类型横条+搜索省一行；桌面布局不变。
- **筛选 chips 统一**（`30b1a3e`）：移动端类型筛选 chips 改 26px（padding 4/10，字号 11px），与标题行日期/星标按钮同大小。
- **好友页搜索框统一**（`6582adf`）：好友位置页搜索框（PrimeVue InputText small）改 36px 高 + 字号 12.5px，与右侧好友栏搜索框一致。
- **搜索框几何钉死**（`7921ff1`）：用户反馈"加载前高、加载完矮"——根因是 webfont 加载前后行高度量变化 + small 变体 padding 竞争。移除 `size="small"`，height/min/max-height 36px + line-height:1 + 上下 padding:0 全写死。
- **右栏搜索内层 input 钉高**（`7718d2c`）：用户 DevTools 实测内层 `<input>` 本体 182×18——外壳 36px 但内部 input 靠字体行高撑（~18px）。rs-input 补 height:100% / min-height:34px / line-height:1，本体与外壳等高。
- **搜索框定稿 32px**（`5696e1c`）：36px 用户反馈偏大，两处搜索框统一降为 32px（内层 min-height 30px），几何仍全部钉死。
- **静默刷新+隐藏空收藏组**（`3bb689c`）：load() 在已有数据时不再置 feedLoading（"同步中…"Tag 闪烁消除，首次加载仍显示）；好友面板收藏好友分组为 0 时整组隐藏（原显示"暂无收藏好友"占位）。
- **移动端日历打不开+窄窗口错乱**（`a5be488`）：① 移动端日期 Popover 点不开——PrimeVue overlay 默认 z-index 与壳层 30/40 同段被压在下面，main.js 配置全局 `zIndex:{modal:1100,overlay:1000,...}` 修复；② 桌面 900-1280px 窄窗口：view-title 允许换行、三段计数独占一行右对齐、搜索框收窄至 120-160px，顶栏不再挤压错乱。
- **Popover 单实例+全弹性工具栏**（`ffe7b3a`）：移动端仍点不开的真因——Popover 实例在 `v-if=!isMobile` 桌面块里，手机上根本没渲染（datePop=null）。改为模板根部**唯一实例**双端共用，日期/星标按钮双端固定在标题行；窄窗口工具栏所有元素（chips `flex:1 1 auto` + 搜索 `flex:1 1 150px`）一起弹性收缩换行，清理 ft-left 死样式。
- **计数回到右上角**（`9cb5616`）：上轮窄窗口规则误把 feed-count 设为 flex-basis:100% 独占一行（视觉掉到标题与多选栏之间）。改回行内 margin-left:auto 贴最右，超长省略（max-width 40%）。
- **桌面详情列禁换行**（`3e6a55b`）：c-detail 桌面 flex-wrap:nowrap + overflow:hidden，超出列宽直接隐藏（文本项可收缩省略）；移动端媒体查询内恢复 wrap。
- **实例徽章禁换行**（`0daa824`）：「邀请+ · US · 16980」等 inst 徽章内文字被压缩折行——补 `flex:none + nowrap + 省略`，空间不足时整体缩宽出省略号而不再断行。
- **移动端动态卡片布局重构**（`b54d86d`）：新增 `groupedRows` 按天分组 → 插入「今天/昨天/YYYY/MM/DD」日期分隔条（延伸线样式），每条动态时间列只显示 HH:MM，日期不重复出现；信息分层=时间/类型Tag/玩家/详情，桌面布局不变。
- **移动端卡片两行并排**（`9b4db62`）：grid 改 `time type detail / player detail detail`——上行 时间+类型，下行 头像名字 | 详情（跨两行占右侧），详情区垂直居中、去虚线分隔、自由换行。解决"左半边在用右边空"+三四行过高问题。
- **右侧详情挤压修复**（`8302109`）：桌面 `.c-detail>*{flex:none}` 在移动端未解除导致内容团在右边折行成塔。移动端覆盖 `*{flex:0 1 auto;max-width:100%}`；world-link/av-name/bio/noti-msg/sdesc 设 `flex:1 1 auto` 伸长省略；玩家名限宽 9.5em；详情左侧加细分隔线与左列视觉分区。
- **移动端卡片两列两行定稿**（`89520b0`）：grid `player meta / time detail`（列 auto+1fr）——行1 头像名字(左)+类型Tag(右)，行2 HH:MM(左下)+详情(右列拿满 1fr)。详情不再被左侧 time/type 两格挤压成团，内容自然流动。
- **回退移动端卡片研究**（`fc548a1`）：用户对研究迭代（日期分组条/两行并排/两列两行，`b54d86d`→`89520b0`）均不满意，回退 FeedView 至 `0daa824`——移动端回到三行卡片式（time type chev / player / detail），移除 groupedRows 日期分组条与并排布局；保留更早移动端优化（标题行日期/星标、禁用展开、chips 26px、实例徽章 nowrap）。
- **移动端第一行改玩家+日期+类型**（`4b2820a`）：grid `player time type / detail detail detail`（列 1fr auto auto）——第一行 玩家(左)｜日期单行 MM/DD(中)｜类型Tag(右)，第二行详情全宽；c-time 移动端只显示日期单行。
- **模型图+名成组**（`5a32964`）：模型变动详情旧图+旧名、新图+新名各包成 `av-pair`（inline-flex+nowrap+flex:none），图与名永不拆行不挤压，名过长省略；箭头独立。

## 2026-08-29 收藏页收藏夹切换 + VRC+ 夹名修复（换机后首轮，Windows 开发机）

- **收藏夹切换 chips**：收藏页原来三个 tab 都把所有收藏夹垂直堆叠（worlds0-3 + vrcPlusWorlds1-2 最多 6 夹 × 100 卡片），翻找困难。三个 tab（世界/模型/好友）顶部各加收藏夹切换 chips——「全部 (N)」+ 各夹（favName + 数量），点夹只看该夹，默认全部（保持原信息密度）；仅 ≥2 个夹时显示 chips。chips 沿用动态页视觉语言（28px 胶囊、active 紫底），移动端单行横向滚动 + 26px（与动态页类型 chips 同处理，899px 断点）。好友 tab 顺带从平铺改为按夹分组（`/favorites?type=friend` 的 `tags[0]` = friends0-2，后端已有字段，零后端改动）。刷新后夹消失自动回退「全部」（effSel 兜底），选中状态跨刷新保留。
- **修复既有 bug：VRC+ 夹名显示原始 tag**：`favName()` 原正则 `(?:vrcPlus)?worlds(\d+)` 匹配不到实际 tag `vrcPlusWorlds1`（**大写 W**）→ VRC+ 专属夹一直显示 `vrcPlusWorlds1` 而非「VRC+ 收藏夹 X」。改 `/i` 大小写不敏感 + `/^vrc/i` 判前缀。9 用例回归通过（worlds0-3/vrcPlusWorlds1-2/avatars/friends/自定义名 chill 透传/空值）。
- **构建产物跨机一致性**：换机 Windows（`core.autocrlf=true`）后 vite 把 CRLF 模板原样带进 dist/index.html，`git diff --check` 报尾随空白、产物 diff 混入换行噪音。build 脚本追加 Node 一行把 dist 规范为 LF——**产物跨机器字节一致**（实验：已提交源码在 Windows 构建与已提交 dist 完全相同，环境无差异；剩余 diff 全为新功能 + 压缩器变量顺移）。package-lock.json 的 libc 字段删改为 Windows npm 环境噪音，不提交。
- **验证**：npm test 7/7、test-registry PASS（102 工具）、check-doc-drift has_drift=false、全 dashboard JS node --check OK、构建通过且 dist 含「收藏夹筛选」标记。
- **已部署**（2026-08-29）：已部署到远端服务器并完成 docker-compose 容器重建，`/health` 通过、`/dashboard` 可访问，TOTP 自动重登正常，dist 指纹为新构建（fv-chips 标记在）。部署前通过 md5 对比确认远端无独有改动；后续从本机部署基线一致，md5 对比应对照工作副本而非 `git show`（LF）。

## 2026-08-29（晚） 修复：同屏引擎改区间重叠判定——用户反馈「次数/时间和 VRCX 对不上」

- **根因（用户实测对比 VRCX 发现）**：findCompanions 旧实现只按 location 字符串匹配——好友进过我窗口内去过的**任意房间**即计入，完全没有时间重叠概念（我周一在的房、朋友周四进也算「同屏」）；matchCount 数的是好友进房次数不是共同在场段数；无时长输出。周报/周报同屏伙伴/get_companions/get_recent_cooplay 全部继承该口径。对照 VRCX-Luo `manualRelations.getCandidateCoInstances`：VRCX 用 join→leave 会话时长（time 字段）按 location 匹配区间重叠。
- **重写（core/analytics/social.js）**：新增 `_buildPresenceSessions()`——从位置事件流重建在场区间 [start,end)（有效位置开启、任何后续事件关闭、同位置重复事件延续、同房间间隔 ≤5min 的穿越/重连合并为连续在场、窗口末尾仍在场闭合于窗口末尾）。findCompanions 改为：我方区间（user-location+迁移残留 friend-location）与好友区间（friend-online 开场/location 变迁/offline 关闭）同 location 求重叠——matchCount=共同在场段数、**新增 minutes=共同在场总分钟数**、firstSeen/lastSeen=首末共同在场时刻。真实库抽样确认 friend-online 带 location 落库（且 friend-online 会更新 friends.last_location 使后续同位置 friend-location 被去重——会话起点必须含 friend-online）。
- **下游同步**：getWeeklyCompanions 合并 minutes；get_recent_cooplay 输出加 minutes；UI「最近一起玩」行改「N 次 · X 小时/分钟 · 最近 MM-DD」（coMinutes：<60 分钟 / ≥600 取整小时）；SKILL.md get_companions/get_recent_cooplay 口径描述更新。
- **回归**：新增 test/test-copresence.test.mjs（5 场景：真共同在场 60min、**不同时间同房间不计入（旧引擎误报回归）**、traveling 切分合并、offline 截断、friend-online 开场）+ 周报合并；npm test 9/9、test-registry PASS（103）、doc-drift false。
- **与 VRCX 的固有残差**（诚实告知用户）：我们只有 WS 位置变迁事件（换房/上线/离线），无游戏内 join/leave 日志——好友中途短暂离房又回来（≤5min 合并内）算连续；好友在我到场前后未产生变迁事件的短 visits 可能漏计；正在进行的会话闭合于「现在」。VRCX 有游戏日志精确到秒。口径对齐后大头数据应一致，小出入属数据源差异。
- **部署实测**（同日增量部署）：容器 healthy、auth/ws 正常；真实数据新口径输出——是决明子喵 21段/768分钟(≈12.8h)/6天、灰绘游-official 6段/504分钟、cheese8567 1段/88分钟；待用户与 VRCX timeTogether 实测对账。

## 2026-08-29 右侧栏新维度：同世界好友 + 最近一起玩（下一步第 2 项完成）

- **同世界好友（纯前端）**：与我在同一世界但不同实例的在线好友（同实例/网页在线排除）。`useFriendGroups.js` 新增 `myWorldId()`（`store.me.location` 首段 wrld_ 解析）与 `sameWorldOf()`（C5 模式与 RightBar/FriendsView 共用）；`groupByWorld()` 同步排除同实例+同世界成员（防同一人两处出现）。RightBar 在「同实例」后加 `pi-compass` 图标分组（折叠 key `sworld`）；FriendsView 加「同世界」tab + 分组（head 带 `fg-loc` 可点开我的房间）。对齐 Luo：`VRCX_sameInstanceAboveFavorites` 置顶语义同款扩展。
- **最近一起玩（后端+前端）**：新 MCP 工具 `get_recent_cooplay`（102→103，复用周报同屏引擎 `getWeeklyCompanions`——北京自然日逐日 `findCompanions` 匹配合并，输出精简列表 matchCount/daysCount/lastDay 按 matchCount 降序；与 get_companions（单窗口、无天数聚合）和 get_friend_pair_screen（两人版）互补）。dashboard 路由 `/api/dashboard/co-play?days=7&limit=30`（state.js `coPlay` 缓存 10min + `registerSocialRoutes` 接通 dashboardState）；前端 store `loadCoPlay()` 10 分钟节流慢路径。RightBar 在「收藏好友」与「离线好友」之间新增区：默认前 8 + 「展开全部 N 人」、区头可折叠，行显示「N 次同屏 · D 天 · 最近 MM-DD」，头像/昵称从 friends/nicknameMap 补全，点击开资料。登记：core/tool-order.json + vrc-monitor-agent SKILL.md 工具表。
- **验证**：npm test 7/7、test-registry PASS（103 工具）、check-doc-drift has_drift=false（code/doc 均 103）、全 JS node --check OK、构建通过且 dist 含 同世界好友/pi-compass/最近一起玩/次同屏 标记。
- **已部署+实测**（2026-08-29，增量部署：只传 12 个变更文件 + docker-compose up -d --build，npm 层缓存命中约 1 分钟）：容器 healthy、auth:true、ws:connected；带 token 实测 `/api/dashboard/co-play?days=7` 返回**真实数据 7 人**（Top：是决明子喵 19次/6天/08-29、轻墨lighk 6次/3天/08-25）；/dashboard 含全部新标记。**增量部署流程成立**（对比全量 tar 快数倍，后续默认增量：SFTP 变更文件 + 重建镜像）。

## 2026-08-29（晚 2） 修复：动态流「资料变化/已记录到本地事件库」无详情事件——全部解析落地（用户反馈）

- **根因三层**：① 管道 `_handleUpdate` 先落 diff 出的带类型子事件（avatar/status/bio/user_icon/pronouns），又**无条件把原始事件再存一份**（content 无 type）——真实库 7 天 290 条 null 子类型 friend-update + 23 条 user-update 全是这种原始重推副本，动态流显示成无详情「资料变化」；② `unknown` 类型（7 天 31 条）content 为空 `{}`，summary 链没覆盖 →「已记录到本地事件库」；③ friend-add/friend-delete 不在 summary 链；资料弹窗的 `dashboard.friendEvents` 链还缺 friend-active/pronouns/displayName。
- **后端（start-monitor.js 两个 service）**：null 子类型原始副本**过滤出动态流/资料弹窗**（diff 子事件已带完整详情，原始副本是纯噪音，历史存量也随之消失）；summary 链补 friend-add「新增好友」/friend-delete「已解除好友」/unknown「未知事件」，friendEvents 链补 friend-active「状态变化」+ pronouns/displayName；events 服务透出 previousUserIcon/previousPronouns/previousDisplayName。
- **管道（event-pipeline）**：`_handleUpdate` 新增 **displayName 改名 diff**（friends 表 display_name 即基线，零迁移），type='displayName' 带旧名→新名——好友改名从此进动态流（此前改名静默）。
- **前端（FeedView）**：typeOf 补 userIcon/pronouns/displayName/friendAdd/friendDelete/unknown 桶（user_icon/pronouns 此前被错归「资料变动」）；详情列加 模板：头像图标 旧图→新图（.uicon 26px 圆形，可点开原图）、代词 旧→新、改名 旧名→新名、成为好友/解除好友、未知事件诚实文案；展开详情加 改名/代词/头像图标 单元格；typeLabels/typeSeverities 同步（friendDelete=danger）。
- **验证**：npm test 9/9、registry PASS（103）、doc-drift false、构建通过且 dist 含全部新标记。**unknown 空载荷诚实说明**：content 为 `{}` 无可解析内容（原始 WS 类型在 ingest 时未保留，后续可考虑存 originalType——本轮不做）。
- **部署实测补收（全量类型清单收口）**：部署后真实数据回归发现 4 个漏网类型——`content-refresh`（VRC+ 内容库道具/捆绑包 add/delete，12条）、`group-joined`（2条）、`group-member-updated`（2条）、`hide/see-notification`（各2条）。已全部解析：summary 链两 service 补齐（内容库：获得/移除道具/捆绑包、加入群组、群组成员信息更新、通知已隐藏/已读）；前端补 contentRefresh/groupJoined/groupMemberUpdated 桶（内容库带物品 ID 可复制、加入群组 groupId 可点开群组），see/hide-notification 归入既有「通知更新」桶；groupId/contentActionType/contentItemId/contentItemTypeLabel 字段透出。**30 天全量 distinct 类型逐一核对，兜底文案仅剩 unknown（空载荷诚实显示「未识别的 VRChat 事件」）**。

## 2026-08-29（晚 3） 根因修复：unknown 空载荷 = WS 数组批量推送被整批丢弃（用户追问「怎么会没有内容」）

- **用户追问直击要害**：事件被推送必有内容，{} 说明采集层丢数据。排查 core/ws-manager.js `_onMessage`：`parsed.type || 'unknown'`——**VRChat 重连后会把积压通知以 JSON 数组批量推送**（VRCX 有同款展开处理），数组没有顶层 type/content → 整包被打成 type='unknown' + content={} → 落库空载荷，**整批事件（通常是通知）每次重连都在丢**。真实库 32 条 unknown 全部 `{}`、且时间上两两成簇（间隔 2-5s）紧贴重连时段，完全吻合。WS 层 eventLog 里有 raw 但仅内存 200 字符调试用；`_storeEvent` 只存 content，raw 被丢弃。
- **修复（ws-manager.js）**：`Array.isArray(parsed)` → 逐条展开走正常归一化（积压通知从此入库）；无 type 的单对象消息 content 兜底为消息本体（unknown 落库不再为空，可回溯解析）；unknown 打 `console.log('[WS] 未识别事件类型: ...')`（下次出现即可从容器日志看到真身，进一步分类）。**兜底文案改为 `未分类事件: <type>`**（两条 summary 链）；动态流 unknown 行展开详情显示事件内容（unknownContent 透出，可复制）。
- **回归**：新增 test/test-ws-parse.test.mjs（5 用例：数组逐条展开/无 type 兜底 content/常规事件不受影响/嵌套 content 字符串/坏 JSON 不崩）；npm test 14/14、registry PASS（103）。
- **部署后观察点**：下次重连时容器日志出现「未识别事件类型」即可定位剩余 unknown 的真实身份；历史 32 条空载荷不可恢复（raw 未落库），此后不再产生。

## 2026-08-29（晚 4） 修复：位置变动「从哪到哪」几乎不显示——prev 被 traveling 事件占据（用户反馈）

- **现象**（浏览器实测确认）：动态流位置变动行大多只显示目的地（如「卡拉不OK」），少数行才有「Just A Cabin → 雨中屋」。
- **根因**：`previousLocationOf` 只取当前事件**上一条** friend-location——但 VRChat 换房前几乎总先推一条 traveling（traveling 也是 friend-location 类型），于是到达行的 prev 几乎全是 traveling（无 world 对象 → 名字为空）→ 前端 `previousWorldName` 为空，「从哪」永远隐藏。同世界短暂重进（A→传送→A）同理。
- **修复**（start-monitor.js dashboard.events）：`previousLocationOf` 改为**向前回溯最多 25 条、跳过 traveling/offline 行**，取第一条带世界的位置（兼容迁移数据顶层 worldName 与实时 world 对象两种形态）；**user-location（自己的位置变动）也走同样逻辑**（此前 prev 只对 friend-location 计算，自己的行从来不会有「从哪」）。同世界重进（prev==当前世界）由前端既有 `previousWorldName !== worldName` 条件自然隐藏，不误显示「从X→X」。
- **验证**：npm test 14/14；部署后浏览器实测到达行显示「从上一世界 → 当前世界」。截图验收（桌面 1440px）。

## 2026-08-29（晚 5） unknown 真身落定：VRChat 服务端错误帧——拦截 + 重认证，敏感值清出事件库（用户反馈触发）

- **真身（上轮埋的日志观测点生效）**：修复 WS 数组展开后，新 unknown 事件带上了真实内容——`{"err":"authToken doesn't correspond with an active session","authToken":"authcookie_...","ip":"..."}`。这是 **VRChat 服务端的 WS 错误帧**（无 type、带 err）：WS 会话被服务端失效（重连窗口期常见），**不是业务事件**。两问题：① 每 3s 连发刷进动态流当「未知事件」；② **帧内含 authcookie 敏感值**，被原样落库且 unknownContent 透出到前端详情。
- **修复（ws-manager.js）**：`_onMessage` 拦截「无 type 且带 err」的帧 → 日志只打 err 文本（**不输出 authToken**）→ `_handleServerErrorFrame()`：10s 单飞 + `api.ensureAuth()`（现成单飞重登录，失败走重连路径既有通知/冷却链）+ `this.ws.close()` 触发自动重连（`_connect` 自带 ensureAuth + 取新 WS token）。错误帧 `continue` 不再进事件管道。通用 unknown 日志同样打码 `authcookie_*`。
- **清理**：路由器库 `DELETE FROM events WHERE type='unknown' AND content_json LIKE '%authToken%'`（5 行）——敏感值清出事件库。
- **验证**：新增 2 单测（错误帧不进事件流+单飞 / 错误帧与常规事件混排常规照常），npm test 16/16；部署后实测：重启窗口来了 2 条错误帧 → 日志打码输出 → 自动重认证 → `ws: connected` 恢复，动态流 0 新增。**剩余 unknown 只有历史空载荷行（随时间滚出动态流窗口）**。

## 2026-08-29（晚 6） 服务运维日志落地：ops_log 表 + get_ops_log 工具 + 「日志」页实装（用户提议）

- **需求（用户提议）**：重登录这类事件「需要一个地方来查看」——此前只进容器日志（用户不可达）+ notify 通知（仅故障达阈值才发）。
- **设计**：新表 `ops_log`（kind auth/ws/ops，level，message，created_at；**独立于 events**——语义不同、不进动态流/MCP 事件查询，写入即裁剪保留最近 500 条）；`core/ops-log.js` **零依赖 sink 注入式助手**（未接线/失败静默 no-op，杜绝 import 环，单测安全）；start-monitor 启动时接线到 storage。
- **打点**：notifier.notifyAuth 入口（每次认证信号，含被聚合未发送的：needsTotp/reauthFailed/recovered/otpFailed）、WS 已连接/断开（带 code）、WS 服务端错误帧（会话失效）、vrchat-api cookie 过期自动重登（开始/成功）。禁止传敏感值（authToken/cookie）。
- **消费**：MCP 工具 `get_ops_log`（103→104，kind 过滤 auth/ws/ops + limit，倒序）注册 tool-order + SKILL.md；dashboard 路由 `/api/dashboard/ops-log`；前端 **「日志」占位页实装为 LogsView**（时间/类别徽章/级别徽章/消息，kind 筛选 chips，30s 自动刷新，移动端 chips 横滚+消息换行）。
- **验证**：npm test 16/16、registry PASS（104）、doc-drift false（104/104）、构建通过。部署后 ops_log 自动产生首批数据（部署重启 → WS 断开/连接打点），/api/dashboard/ops-log 返回真实条目，「日志」页浏览器截图验收。

## 2026-08-29（晚 7） 修复：动态页「加载更多/自动加载」消失——JS 层过滤破坏分页判定（用户反馈）

- **现象**：动态页滚动触底不再自动加载，「加载更多」按钮消失（已加载 58 / 数据库 3839，明显没到底）。
- **根因**：上一轮「过滤无子类型原始副本」做在 **JS 层**（SQL 取 LIMIT 50 之后才滤）——每页实际返回 **< 50 条**（副本约占 19%），前端 `feedHasMore = more.length >= 50` 误判"数据库到底"→ 按钮隐藏 + fillFeed no-op。教训：**过滤必须与分页同一层**。
- **修复**：过滤条件下沉到 dashboard.events 的 SQL WHERE（主查询与 COUNT 查询同条件，alias 区分）——LIMIT/OFFSET/total 全部在过滤后数据集上一致；JS 层 filter(Boolean) 保留为兜底。
- **验证**：npm test 16/16；部署后 API 分页实测 offset=0/50 各返回完整 50 条且内容不重叠，动态页滚动续载恢复。

## 2026-08-29（晚 8） 动态页三连：删封顶提示 / 筛选切换加载态 / 全接口 gzip（用户反馈）

- **删封顶提示**：「已显示最近 400 条，更早内容请用日期筛选」移除（用户拍板）；硬上限本身保留（性能保护），只是不再显示提示文案。
- **筛选切换闪「暂无动态」**：resetFeed（切筛选/日期时）不置 feedLoading → 拉取期间 rows 为空闪「暂无动态」。修复：resetFeed 置 feedLoading=true + finally=false——复用既有「正在加载动态…」spinner 分支，真无数据才显示暂无。
- **加载慢（实测后端仅 44-100ms，慢在传输）**：`server/http.js` 的 sendJson/sendHtml 均未压缩——动态流 JSON 80KB、单文件页面 1.27MB 裸传家宽上行。修复：**gzip 压缩**（经 `res.req.headers['accept-encoding']` 判断，零调用点改动；>1KB 才压，gzipSync 内存级足够）：JSON ~80KB→~12KB、页面 1.27MB→~300KB。MCP 等非浏览器客户端不带 Accept-Encoding 自动回退原文，兼容无损。
- **验证**：npm test 16/16、构建通过；部署后实测——events 89.7KB→**6.2KB（gzip）**、dashboard 页面 1249KB→**414KB**、identity 客户端自动回退原文。
- **重大教训（gzip 首次部署失效的根因）**：经 bash→python 双层转义写正则 `\bgzip\b`，`\b` 被腐蚀成 **0x08 退格控制字符**写进文件（JSON.stringify 才能看出：`"\b"` 单反斜杠 = 控制字符，非 `\\b` 双字符）——正则永远匹配不上，gzip 静默失效。修复：该行改用**零反斜杠实现**（`enc.toLowerCase().split(',').some(t => t.trim() === 'gzip')`）。**确立规则：经 bash-heredoc python 写文件时源码里禁止出现反斜杠序列；含转义的代码一律走 Edit 工具或零反斜杠等价写法；写完后对改动文件做控制字符扫描**（本次扫描其余 21 个今日改动文件均干净）。

## 2026-08-29（晚 9） 运维日志补全认证「结果」——成败闭环（用户反馈）

- **现象（用户看服务日志页发现）**：只有「Auth cookie 过期，自动凭据重登录...」没有下文——重登走 2FA 分支抛 needsOtp 时绕过了此前只埋在成功路径的记录点，成败断篇。
- **修复（vrchat-api.js）**：在两个顶层认证入口 `ensureAuth` / `ensureAuthWithAutoOtp` 包结果记录——成功 `认证完成：会话有效` / `自动认证成功（2FA 已自动完成）`（info）；失败按原因分类 `认证失败：需要 2FA 验证码 / 需要手动提交 TOTP / <错误消息>`（warn）。单飞锁保持不变，内部多路径（邮箱 OTP/自动 TOTP 兜底/手动转交）统一收口到这两个出口，日志链变成：**过期 → 重登录 → 成败结果** 三段完整。
- **验证**：npm test 16/16；部署后 ops_log 自动产生「认证完成：会话有效」条目（部署重启的 WS 重连触发 ensureAuth）。

## 2026-08-29（晚 10） 修复：日志页显示 UTC 时间——改用 utils 本地时区（用户反馈）

- **根因**：LogsView 自己写的 `timeOf/dateOf` 直接 `slice` ISO 字符串（ISO 是 UTC）→ 显示 UTC；动态页用的是 `utils.js` 的 `time`/`date`（`toLocaleTimeString/DateString('zh-CN')` 本地时区）。
- **修复**：LogsView 改为 import utils 的 `time`/`date`，与全站时间口径一致（这也是一次 C5 式教训：**时间格式化必须走 utils 共享函数，禁止视图内私自 slice ISO**）。

## 2026-08-29（晚 11） 认证循环「一直在重新认证」——消自放大 + 待查外部顶号（用户反馈）

- **现象（服务日志页暴露）**：错误帧→重认证→连接→几分钟后会话又被掐→再重认证，循环往复；期间「cookie 过期重登录」反复出现、还夹一次「认证失败：需要 2FA」。
- **两条自放大因素（已修）**：① ws 错误帧处理器里额外调了一次 ensureAuth，与重连路径（_connect 自带 ensureAuth+新 token）叠加放大凭据登录频率 → 改为**只断开触发重连**；② 凭据重登录**无冷却**——若另一个客户端也在用同一账号凭据登录，双方互踢会话形成登录风暴 → `_doEnsureAuth` 过期分支加 **60s 冷却**（冷却期满先重验 cookie——上轮登录可能已刷新它，无效才真正重登录）。
- **关键待查（已请用户确认）**：会话反复被服务端掐最常见的外因是**同账号另一客户端在做凭据登录**（VRCX/手机 App/别的部署）——双方互踢。若用户确实同时开着 VRCX，需在 VRCX 侧也用同一 cookie 或错峰。
- **排查结论（用户确认 VRCX 未登录后）**：① 本机（Windows）无 node/python 进程、无相关计划任务/服务——19:14 有过一次本地实例登录（交接前测试残留），已不在运行、无自启机制；② 路由器侧 3 个历史工作副本（hermes-agent 容器 ×2、deepseek-harness 容器 ×1 带 8/27 旧 cookie）均**无进程在跑**、无 cron——非现行犯，但建议择机清理防未来误启动（属其他 agent 环境，需用户批准）；③ 反风暴修复部署后 **23 分钟无任何认证警告**（修复前 2-10 分钟一轮），ws connected 稳定——循环已停。最初诱因未最终定位（不排除 VRChat 服务端会话策略/临时网络问题），但 60s 凭据冷却保证即使复发也不会演变成登录风暴。
- **验证**：npm test 16/16（错误帧单测同步改为断言 close 单飞）；部署后观察 ops_log 循环频率是否显著下降。

## 2026-08-29（晚 12） 认证失败日志补错误码 + 文案去误导（用户反馈）

- **用户反馈两点**：① 认证失败不显示错误代码；② 「需要手动提交 TOTP」措辞误导——实际服务在**自动**获取提交 TOTP，写成"手动"会让用户以为要自己去提交。
- **根因**：`_verify2fa` 抛错只带 HTTP 状态不带 VRChat 错误响应体；顶层包装层又把中间层已有的细节（`TOTP 自动登录失败(2FA 验证失败 (HTTP xxx))...`）丢弃，渲染成笼统的「需要手动提交 TOTP」。
- **修复**：① `_verify2fa` 失败时带上 VRChat 错误响应体（JSON 截 200 字符）+ `statusCode` + 429 限流标记（联动 _setAuthCooldown 300s）；② 中间层文案改如实：「自动提交 TOTP 被拒(...)；服务将继续自动重试，必要时可调用 submit_totp 手动提交」；③ 包装层渲染 `err.message` 全文，不再丢弃/加"手动"措辞。
- **验证**：npm test 16/16；下次认证失败时日志将显示类似「自动认证失败：自动提交 TOTP 被拒(2FA 验证失败 (HTTP 401)：{"error":{...}})...」的可定位信息。

## 2026-08-29（晚 13） 会话失效风暴检测——多 WAN 场景主动提示用户（用户提议）

- **提议（用户）**：多 WAN 会导致 token 一直失效，要不要提示一下用户？——采纳。
- **实现（ws-manager）**：`_trackSessionChurn()` 在每个服务端失效帧处计数（先于 10s close 单飞），**30 分钟窗口内 ≥3 帧** → 判定出口 IP 轮换风暴 → 记 ops_log（ops/warn，含根因解释与修复建议：路由器将本服务出口固定单一 WAN）+ `notifier.notifyAuth('sessionChurn', ...)` 走桌面/webhook 通知；**1 小时内不重复提示**，提示后计数清零重累计。服务侧自动恢复不变——提示的目的是让用户知道根因在网络出口而非账号/服务。
- **验证**：新增风暴检测单测（<3 次不提示/达阈值提示一次含建议/1 小时去重）；npm test 17/17。当前环境已用 mwan3 源地址策略修复（出口钉死 wan），该检测器用于回归哨兵与未来部署环境。

## 2026-08-29（晚 14） 服务日志补进程启停打点——部署重启可见（用户反馈）

- **用户反馈**：服务日志看不出「部署重启」——每轮部署重建容器后的认证循环没有上下文。排查确认：23:46/23:50/23:55 三轮重登**就是我连续部署的容器重建**（RestartCount=0、无 OOM、内存 65MB/31GB、cookie 随重启更新），非持续故障。
- **修复（start-monitor.js）**：main() 启动时打 `服务进程启动（v版本，部署/容器重建/手动重启）`；shutdown(signal) 打 `服务进程停止（SIGTERM——容器重建/手动停止）`。部署节奏从此在「日志」页自解释：**停止 → 启动 → 认证** 三连即一次部署。
- **顺带澄清**：每次容器重建后触发一次凭据重登，是因为 VRChat 在连接期间轮换 cookie、进程被杀时最新值可能来不及落盘——部署频率低时可接受；若未来需要频繁部署可再优化（如启动时先验旧 cookie 双值）。
- **验证**：npm test 16/16；部署后 ops_log 首条即「服务进程启动」。

## 2026-08-30 修复：断线窗口好友下线状态卡死——在线状态对账（用户反馈 + vrchat.community API 文档）

- **现象（用户）**：断连期间有人下线，重连后其状态不更新、一直显示在线。
- **根因**：`_refreshOnlineState`（WS 连接后触发）只把 API 在线列表的人**置为在线**，从不把消失的人置离线——断线期间的下线事件错过即永久丢失（好友下线不会补广播）。
- **API 语义澄清（vrchat.community /reference/get-friends）**：`offline=false` = 仅在线+active 好友；`offline=true` = **仅离线**（非「全量」——此前 fix #9「offline=true 拉全部」的理解有误，_syncFriendAvatars 实际只覆盖离线好友，待后续核对）；`state` 枚举 online/active/offline，location 仅在实例中时存在。
- **修复**：`_refreshOnlineState` 重写为对账式——分页拉全在线+active 集合（任一页失败或未到尾页则放弃本轮对账防误标）→ 批量置在线（含 active 网页好友，旧实现 location 过滤会漏掉他们）→ 与好友表 `is_online=1` 对账，差集置离线 + 补记 `friend-offline` 事件（source=api_poll，记对账时刻——准确下线时刻在断线窗口内无法得知）。
- **验证**：npm test 17/17；部署后对比好友表在线集合与 API 实时在线列表（应一致）。

## 2026-08-30（续） 对账离线事件显示「API 掉线期间离线（窗口）」（用户反馈）

- **需求**：对账补记的离线（非 WS 实时推送）详情不能只显示「离线」——要显示玩家在 API 掉线期间离线（时间窗口）。
- **实现**：对账事件 contentJson 带三时刻——`offlineWindowStart`（WS 最近一次断开时刻，取 `ctx.wsManager.disconnectedAt`）、`detectedAt`（对账确认时刻）、`lastSeen`（好友最后活动时刻，更紧的下界）；events 服务透出 reconcile/offlineWindowStart/reconcileDetectedAt/lastSeenAt；summary 对账的显示「掉线期间离线」。前端详情列：「API 掉线期间离线（HH:MM ~ HH:MM）」（无窗口时显示「对账确认离线（时刻）」）；展开详情加「下线判定：断线窗口对账（窗口）」与「最后在线」单元格。
- **语义边界（如实）**：窗口起点用 WS 断开时刻而非好友 last_seen——last_seen 更紧但可能落在上一轮窗口；准确下线时刻在断线期间无法得知，窗口表达的是「确定在这段期间内离线」。
- **验证**：npm test 17/17、构建通过、dist 含全部新标记。真实效果待下次断线+好友离线时在动态流验收。

## 2026-08-30（续） 事件解析完整性审计二轮——群组名解析 + 内容库类型全映射（用户反馈）

- **用户反馈**：加入群组只显示裸 groupId；内容库出现「获得accessory」中英混杂；要求排查所有解析不全的情况。
- **全类型审计（DB 载荷逐一核对）**：① `group-joined`/`group-member-updated` 只有 groupId（`group_cache` 表为空——群名从未被缓存）；② `content-refresh` 的 itemType 实测有 prop/bundle/accessory/**shared**（映射表只覆盖前两个，accessory 落英文原文）；③ hide/see-notification 的 content 是裸字符串 ID（摘要链不受影响✓）；④ friend-add 带 user 对象✓。
- **修复**：① 群组名解析——映射时 `group_cache` 缓存优先，未命中的丢后台限流拉 `/groups/{id}` 回填缓存并回填本次响应（仿 avatarName 模式，每次最多 5 个）；summary 与 notiGroupName 融合解析结果（前端 groupJoined 已支持群名可点击开群组，有群名时不再裸显 ID）；② content-refresh 类型映射补 accessory→配件、shared→共享物品（backend summary + contentItemTypeLabel 两处）；③ group-member-updated 的 content 形态是 member{groupId,userId,isRepresenting,roleIds}（自己的群组成员信息变化）。
- **验证**：npm test 17/17、构建通过；部署后实测 group-joined 显示解析出的群名（首次请求后台拉取、30s 后刷新即有名字）、accessory 显示「获得配件」。

## 2026-08-30（续 2） 内容库事件解析物品名+缩略图（用户反馈）

- **用户反馈**：内容库事件只显示 inv_ 裸 ID，不知道是啥东西、也没图。
- **实现**：接 vrchat.community API 文档的 `GET /inventory/{inventoryItemId}`（返回 name/imageUrl/itemType/itemTypeLabel）。dashboard.events 按 avatarName 同款模式：planet_cache（`invitem:{itemId}`）缓存优先预载 → 未命中的丢后台限流拉取 → 回填响应 + 落盘；映射透出 contentItemName/contentItemImageUrl。**已移除（delete）的物品可能 404**（不在库存内）→ 如实保留 ID 显示。
- **前端**：详情列显示缩略图（可点开原图）+ 物品名；无名字时回退 ID（复制按钮保留，title 带上下文）。
- **验证**：npm test 17/17、构建通过；部署后实测 add 类物品解析出名称+图（delete 类视库存状态）。

## 2026-08-30（晚） API 全量审计落地——157 方法域面 + 插件透传 + 双列表修正（用户要求：全都要+整合）

- **背景（用户拍板）**：API 全都要（可能用得到），并把散落端点整合进 API 层。审计对照 vrchat.community 文档 24 分类 + VRCX-Luo src/api 全部用法，产出 **docs/API-AUDIT.md**（三方覆盖对照/行为实测/修正清单/未覆盖决策/整合规范）。
- **实现**：① `vrchat-api.js` 新增全量域方法面（**157 方法**：System/Users/Friends/Worlds/Instances/Groups/Favorites/Notifications/Avatars/Files/Inventory/PlayerModeration/InviteMessages/Prints/Calendar + 通用 get/post/put/del + `_q` 查询组装）；② `buildVrchatApi` 改 **Proxy 透传**——插件 `api.vrchat.<method>` 直达全部域方法（自动限流），`_` 私有不透传；③ 修正 `_syncFriendAvatars` offline=true 误用（文档实测：offline=true 仅离线，全量=双列表合并）；④ 实测记录固化：friends 不传参数=仅在线（2/13）、visits 可用（108304）。
- **覆盖决策**：Economy 深度管理（Tilia/创作者）、File 分块上传协议、Props、部分未展开路径的端点**未包**（路径未核实前不猜不发，清单+核实方式见 API-AUDIT §4）。
- **验证**：新增 test-api-surface 单测 4 用例（分类存在性抽查/_q 组装/friends 语义固化/Proxy 透传+限流+私有隐藏），npm test **21/21**、registry PASS（104 工具不受影响）；部署后烟雾验证新方法（getVisits/getFriendStatus）。

## 2026-08-30（深夜） API 覆盖清零——OpenAPI 规格驱动 222 方法生成（用户拍板「全都需要」）

- **演进**：晚 11 的「未覆盖清单」（Economy/File 协议/Props——路径未核实不猜不发）被用户拍板推翻 → 找到官方 **OpenAPI 3.0.3 规格文件**（vrchat.community/openapi.json，232 路径/297 操作），**机械生成 222 个规格方法**（vrchat-api-spec.js，生成器脚本一次性输出，跳过与手写层重名的 75 个）。
- **意外收获**：跳过清单对照出手写层 **5 处路径错误**（selectAvatar/selectFallbackAvatar/logout/getUserGroupRequests/deleteGroupInvite），全部按官方 spec 纠正。
- **架构**：手写层（vrchat-api.js 158 方法，热路径更优口径）+ 规格层（vrchat-api-spec.js 222 方法，`_specCall` 路径参数展开+查询组装）= **380 方法全量面**；插件 Proxy 透传自动覆盖两层。
- **验证**：npm test **22/22**（新增规格层抽查）；容器内实测方法数 380。
- **待实弹**：规格层写操作（Economy/Props/File 协议）路径来自官方 spec 但未逐一实弹（避免真实副作用）；需要时直接调用即可。

## 2026-08-30（CI 拦截） 恢复被误删的 4 个社交分析方法——快照测试价值实证

- **CI 拦截**：push 后 CI「Storage behavior-equivalence snapshot」双平台失败（该测试不在 npm test glob 内，本地一直没跑到）。根因：同屏引擎重写（bc5aa51）的替换区间（findCompanions → getWeeklyCompanions）把夹在中间的 **findFriendPairScreen / findFriendPairMeetings / getOnlinePattern / getOwnWorldSessions** 四个方法整块误删——资料弹窗同屏查询、上线规律、世界会话在路由器上已坏。
- **恢复**：从 bc5aa51~1 提取四个原函数插回（保留旧 ±30min 事件对口径——pair-screen 与 companions 是两套文档化语义）；快照剩余 2 处漂移为**有意变更**（findCompanions 区间新输出 + getWeeklyCompanions minutes 字段），按测试设计流程 `--generate` 重录基线（62 探测点）。
- **教训入档**：① 快照测试正是为「大区间替换」设计的防线，这次它起作用了；② 本地 `npm test` 的 glob 不含非 `*.test.mjs` 的 CI 专属测试——**改动 core 后必须手动跑全 CI 步骤等价命令**（snapshot/migrate/doc-drift/registry）。
- **验证**：snapshot 62 点无漂移、migrate 25 PASS、doc-drift false、registry 104 PASS、npm test 22/22；已部署修复线上 pair-screen。

## 2026-08-30（续） 修复：重连竞态导致离线双记（用户反馈：为什么有两个离线）

- **现象**：cheese8567 同一分钟两条下线——一条「离线」（WS 实时推送）+ 一条「对账确认离线」。竞态：重连瞬间对账与 VRChat 的实时下线推送几乎同时到达，对账查询时实时事件尚未入账 → 误判为「断线窗口漏掉」补了第二条。
- **双向去重修复**：① 对账侧——补事件前查同窗口（断线起点起，或近 10 分钟）是否已有该好友 offline 事件，有则只修状态不补事件；② 管道侧——实时下线到达时，若 10 分钟内已有对账补记（reconcile=1）的同好友 offline 事件，实时为准、跳过重复存储。③ 重连后对账**延迟 25 秒**执行，先让突发推送落地再对账。
- **数据清理**：库内既有重复 1 对（对账 4213 vs 实时 4214），备份后删除对账保留实时。
- **验证**：npm test 22/22；cheese8567 的离线事件仅剩实时记录。

## 2026-08-30（深夜） 三角色专业审查（UI/架构/测试）——发现即修

- **UI 走查（浏览器实测四视图双端）**：动态/好友/收藏/日志 × 桌面 1440 + 手机 390 全截图。发现并修复：**收藏页加载中误显「0 项」**（与动态页同款毛病——loading 时计数应显示「加载中…」）。其余良好：手机端卡片/筛选 chips 横滚/底栏 safe-area、好友页世界分组头、日志页徽章与消息换行、收藏夹切换 chips 均正常；hidden→好友+ 修复已在线上生效（好友+ · JP · 77806）。
- **测试工程师**：`npm test` glob（`*.test.mjs`）**不覆盖** registry/snapshot/migrate 三个 CI 专属测试——这正是上次 CI 拦截误删事故能溜进 main 的根因。修复：`npm test` 现为 **CI 全等价**（单测 + registry + snapshot + migrate 四连）；`test:unit`（快速单测）与 `test:live`（需凭据的实弹脚本）分离。
- **架构工程师**：① 全仓库 JS 语法扫描 OK（含新增 spec 层）；② 敏感物入库检查 OK（仅 example 模板）；③ ~~架构债登记：`dashboard.events` 服务 323 行巨函数位于 start-monitor（应下沉到插件 server 模块）~~ **已重构（08-30 晚）**：`dashboard.*` 全部 19 个服务 + SSE 总线从 start-monitor.js 下沉到 `core/dashboard-services.js`（`registerDashboardServices`，owner 仍为 `core`——插件契约禁止触碰 ctx/核心表，故服务实现保留 core 侧、注册代码移出主入口）；逐字节搬移（966 行 diff 一致）+ mock 冒烟 19 服务齐全 + npm test CI 全等价通过；start-monitor.js 1703→740 行恢复薄入口；④ 限流/缓存/gzip/鉴权横切面此前已就位。
- **验证**：npm test（CI 全等价）22 单测 + registry 104 + snapshot 62 点 + migrate 25 + doc-drift false；构建通过。

## 2026-08-30（深夜 2） 首席架构师深度审查——1 Critical 并发 + 3 HTTP 层缺陷（五维度排查）

- **[Critical] WS 事件 fire-and-forget 并发**（ws-manager `_onMessage`）：onEvent 为 async（内含限流 2.6s/req 的世界名解析）却不 await——突发 N 条事件 = N 条并发处理链：**事件乱序**（位置去重/状态假设全破坏）+ **无界并发**（内存/限流队列爆炸）。修复：`_evtChain` 链式串行（到达序、并发度 1，不阻塞 WS 接收循环）；单测证明阻塞期后续不插队、并发度 1。
- **[Major] MCP sessions Map 无限增长**（http-server `getOrCreateSession`）：无有效 session 的请求新建会话且永不驱逐 = 认证后的内存 DoS 面。修复：200 上限 LRU 近似 + 2 小时 TTL + get 续命。
- **[Major] POST /mcp body 无上限**：`body += chunk` 无界累积 = 内存 DoS。修复：1MB 上限，超限断连回 413。同步：dashboard `readJsonBody` 加 1MB 上限。
- **[Minor] MCP 握手版本硬编码 1.14.0**（实际 3.1.0）：改 `ctx.serverState.version`（启动注入）。
- **安全排查结论（无发现）**：鉴权在路由分发前拦截 ✓；SQL 全参数化（插值均为代码控制列名/占位符）✓；Vue 层无 v-html、legacy innerHTML 均过 esc() ✓；ops_log/日志已做令牌打码 ✓。
- **验证**：npm test **23/23**（新增串行队列单测：阻塞期不插队/并发度 1/释放后保序）、registry 104 PASS、doc-drift false。

## 2026-08-30（深夜 2） 第一批占位页实装：通知 + 搜索 + 足迹（3/10）

- **通知（NotificationsView）**：新增 GET `/api/dashboard/notifications`（notificationEvents 服务增强：补 imageUrl/title/groupName 字段）+ POST `/api/dashboard/notification-action`（see/hide/accept/decline 四动作经工具）。前端：类型 chips 七选一（好友申请/邀请/请求邀请/群组/私信/其他）、行式列表（发送者头像/名字可点开资料、类型徽章、时间）、好友申请行内 接受/拒绝 按钮、其余 已读/隐藏 按钮（乐观更新+失败回滚）、图片预览。60s 静默刷新。
- **搜索（SearchView）**：新增 GET `/api/dashboard/search?type=users|worlds|groups&q=&limit=`（规范化三个 search 工具的响应为统一 {kind,id,name,sub,image}）。前端：类型 chips + 500ms 防抖搜索框 + 序号防过期响应 + 结果行（点击开对应弹窗）。
- **足迹（WorldsView）**：复用 `/api/dashboard/recent-worlds`（服务补 `MAX(wc.note) AS note`）——卡片网格（封面/名字/最后访问时刻/访问次数/备注标记）+ 世界名过滤 + 只看有备注 chips；点击开 WorldDialog。
- **验证**：npm test 23/23（全等价四连含 registry/snapshot/migrate）、构建通过；部署后浏览器逐页走查（动态/好友/收藏/日志 截图 + 通知/搜索/足迹实测）。
- **重大插曲（已修）**：部署后 recent-worlds 404 → 根因是 **index.js 与 server/routes/social.js 双重注册 /api/dashboard/notifications**（昨晚我在 social.js 加过富版全家桶，今天又在 index.js 加了薄版）——`registerRoute` 对重复路径抛「HTTP 路由冲突」，registerSearchRoutes 之后的 registerFavorite/Avatar/Social/ImageProxy/recent-worlds **全部没注册**（收藏/搜索/足迹/图片代理在线上真坏了）。修复：删 index.js 薄版重复路由（保留 social.js 富版：当前通知+历史+enrich），NotificationsView 按富版形状重写（**当前可操作区**：好友申请接受/拒绝、已读/隐藏；**历史只读区**：来自 notificationEvents 的时间线）。**教训入档：插件加路由前必须先 grep server/routes/ 全目录查重——重复不是覆盖而是抛错中断整个插件后续注册**。实测三路由全 200（recent-worlds 12 世界/search Cube 归一化结果/notifications 当前+历史）。

## 下一步（VRCX 对齐候选）

1. 用 `web-design-guidelines` 审查 Dashboard 前端 UI/可访问性（P1/P2 已修，P3 已完成，剩余可迭代）
2. ~~右侧好友栏更多维度（世界内好友、最近一起玩）~~ → 已完成（2026-08-29，同世界好友 + 最近一起玩，见上）
3. ~~收藏世界按收藏夹切换的 UI 交互细化~~ → 已完成（2026-08-29，见上）

## 用户反馈修复（2026-08-26 批量）

1. **顶栏/侧栏导航去重**：删除顶栏 `<nav>`，保留侧栏唯一导航
2. **avatar→“模型”文案**：好友动态/事件详情统一“模型”，展开详情显示 模型名 + 模型 ID
3. **网页在线判定修正**：`isWebOnline` 增加 location='offline' / worldId 非 wrld_ 判定（VRChat 网页在线特征）；单测补充 4 用例
4. **右侧好友面板信任色**：去掉信任名牌，名字用 `trustColor`（VRCX 信任等级色）着色
5. **连接状态去重**：删除顶栏 connection 与侧栏 AUTH/WS，仅保留底部状态栏
6. **最近访问世界改为真实**：`dashboard.recentWorlds` 只查 `user-location`（自己访问），不再混入好友记录；容器实测返回自己真实访问世界
7. **当前模型显示名字**：`/auth/user` 无 currentAvatarName，改从上传列表按 avatarId 匹配名字
8. **通知类型对齐 VRCX**：`notificationTypeLabel` 扩展 groupInvite/groupJoinRequest/requestInvite/requestInviteResponse/votetokick/giftSub/friendRequestResponse 等
9. **头像灰色修复（占位 → 真实头像）**：3 个离线好友（Helionix/HT1657/XiangXiangYa）无头像。根因（两步排查）：① 补全任务字段名错（`avatarImageUrl` vs VRChat API 的 `currentAvatarImageUrl`）② 更关键——**`/auth/user/friends` 默认只返回在线好友（offline=false）**，补全拉到 0。修复：加 `offline=true` 拉全部好友 + 字段名修正（VRCX 正是用 offline=true）；已手动更新 DB + 部署，3 人头像恢复真实显示；`img()` 无头像时仍保留等级色首字母占位兜底
10. **Dashboard 请求失败回归修复**：删除连接状态元素时漏清 `load()` 裸引用（TypeError 中断）→ 已删裸引用恢复
11. **事件展开详情模型 ID**：事件管道 avatar payload 与 events 服务各补 `avatarId`（`currentAvatar`），前端展开详情显示 模型名 + `avtr_xxx` ID

## 验证命令（工作副本根目录）

```bash
# 前端拼接 JS 语法（util+views+app）
node --check /tmp/final.js   # 先拼接：util.js + views.js + app.js 写入 /tmp
# 后端语法
node --check plugins/official/web-dashboard/index.js
# 全部语法
for f in $(find plugins/official/web-dashboard -name '*.js'); do node --check "$f" || echo "FAIL $f"; done
# 冒烟：mock register → 23 路由无重复 + disposer
git diff --check
```

## 2026-08-30（下午） 7 个占位页全部实装 + 后端缺口补全 + dashboard 服务下沉

- **7 个占位页全部实装（14 视图全实装，PlaceholderView 仅作兜底）**：
  - `TrackedView`（非好友追踪，全新实现——旧版无此视图）+ 后端新增 `dashboard.trackedNonFriends` 服务（core/dashboard-services.js，读 tracked_non_friends）+ 路由 `GET /api/dashboard/tracked`
  - `PlayersView`（房间玩家：/player-list，当前实例 + 同房好友 + 世界封面/容量/平台）
  - `AvatarsView`（我的模型/收藏模型双 tab + 搜索，/avatars）
  - `ModerationView`（黑名单/静音双 tab + 解除）
  - `ChartsView`（在线热图 + 活跃时段分布 + 事件类型分布，/stats + /game-sessions + /activity-heatmap）
  - `ToolsView`（手动同步 + ID 跳转/链接生成复制，store 的 openUser/openWorld/openAvatar/openGroup + copyText）
  - `OpenView`（ID/链接直接打开弹窗）
- **后端缺口补全**：
  - `POST /api/dashboard/moderation/delete`（旧前端调过但后端从未实现）：`api.vrchat.unplayerModerate(userId, type)`（PUT /auth/user/unplayermoderate），参数校验 + 失效缓存
  - store.js viewMap 补 `tracked`
- **架构债重构（承接早间）**：`dashboard.*` 19 服务 + SSE 总线下沉到 `core/dashboard-services.js`（`registerDashboardServices`，owner 仍 core），start-monitor.js 1703→739 行恢复薄入口；搬移块与 HEAD 逐字节一致
- **验证**：npm test CI 全等价通过（23 单测 + registry 104 + snapshot 62 点 + migrate 25 + doc-drift false）；本地假凭据实例 8899 端到端：/dashboard 新构建 1,333,899B、tracked/player-list/moderation/avatars/stats/heatmap 全 200、SSE connected、auth-guard 401 拦截、moderation/delete 参数校验生效；dashboard-probe 16/16
- **注意**：测试期根目录遗留 auth_cookie.txt 已按设计迁移至 data/（issue #103）；本地跑测试实例必须用独立端口 + 假凭据（防双实例互抢 OTP）

## 2026-08-30（夜） 自主开发批次（使用者授权连续开发，每批备份+部署+CI绿）

- **非好友追踪增强**：trackedChanges 服务/路由 + TrackedView 变化时间线（bio/status 前后值对比、展开详情、最近变化时间）；_refreshTrackedNonFriends 增加头像 diff 落库（type=avatar 事件）+ 前端新旧头像缩略图对比；「立即刷新」按钮（dashboard.refreshTracked 服务 fire-and-forget + POST /tracked/refresh）
- **图表页增强**：每日活动量（byDay 柱状）+ 活跃好友 Top10（可点击打开资料）；修复 legacy 前端 AvatarsView a.id→avatarId 的模型点击 bug
- **周报页面**：GET /api/dashboard/weekly-report（复用 get_weekly_report）+ WeeklyReportView（概览卡片/每日足迹/世界Top/同屏伙伴/群组活动/上线规律，7/14/30 天）
- **X 博主推荐页**：GET /api/dashboard/x-worlds（x.worlds + x.creators）+ XWorldsView（博主 chips + 推荐世界卡片）
- **清理**：移除 /me 路由 [me-dbg] 调试日志
- **备份铁律**：scripts/backup-prod.sh（MCP backup_database 在线备份 + 宿主机轮换保留 10 份，SSE 解析 + KEEP 内联修复），每批部署前执行
- **验证**：每批 npm test CI 全等价 + doc-drift 绿 + deploy.sh 部署 + verify-container 全绿 + 真实数据验证（周报 7 天 49h/18 世界/7 伙伴；tracked 变化时间线 busy→join me）

## 2026-08-30（深夜 2） 自主开发第二段（新页面批次）

- **周报页**：GET /api/dashboard/weekly-report（复用 get_weekly_report，按 days 缓存 5min，实测 1.31s→0.0s）
- **X 博主推荐页**：GET /api/dashboard/x-worlds（x.worlds + x.creators 本地表，秒回）
- **世界推荐页**：GET /api/dashboard/recommend-worlds（recommend_worlds 多源融合，按 theme 缓存 5min；首拉 11.1s 含 Planet 抓取）
- **我的群组页**：GET /api/dashboard/my-groups（get_user_groups，缓存 5min；真实 26 群组）
- **社区活动页**：GET /api/dashboard/community-events（fetch_community_events，按 window 缓存 10min；首拉含群组挖掘 48s，无 Google key 时 RLVRC 源仍可用，真实 2 活动）
- **好友行在线/离线时长**：onlineSince/offlineSince（lastOnline/lastOffline 驱动，3 处在线行 + 离线行统一）
- **测试**：test-dashboard-services.test.mjs（trackedChanges/trackedNonFriends/stats/heatmap rangeDays 回归），npm test 29 个
- **修复**：activityHeatmap 重复对象键 {days:d,days:out}（天数被覆盖）；/me 调试日志移除
- **侧栏现 20 视图**；每批部署前 scripts/backup-prod.sh 备份（MCP 在线备份 + 宿主机轮换 10 份）


## 2026-08-30（深夜 3） 自主开发第三段（深度审查修复闭环 + 反馈闭环）

- **第三方全量审查**（28 提交，核对编译产物与调用链）：3 🔴 + 2 🟡 + 若干 🟢 全部修复
  - 🔴 TrackedView fmtRefresh 未定义 / FriendsView locLabelFull 未 import / player-list 服务返回数组但路由读 .friends
  - 🟡 refreshTracked 并发闸 / 实例类型正则 friends+（前后端同步）
  - 🟢 moderation/delete 安全模式拦截 / 头像 diff file-id 归一化 / worldHistory LIKE 转义 / trackedChanges 头像缩略图 / EventsView 展开 key 唯一化 / community-events in-flight 去重 / JSON.parse 保护 / previousAvatarImageUrl 漏映射（测试抓出）
- **世界推荐反馈闭环**：POST /world/rate（rate_world）+ /world/visited + RecommendView 👍/👎/✓ 按钮 + 已逛角标
- **X 博主管理**：添加/扫描/移除（走 MCP 工具尊重安全模式）；X 抓取三通道在本环境不可用（2026 反爬 + 无头容器无浏览器）
- **动态页**：按天分组分隔条（今天/昨天/MM-DD）+ 「只看关注」/「只看我」筛选 + 关注 👁 标识（动态行/右侧好友栏 5 处）
- **页脚**：运行时长 + 🔒 安全模式徽标 + 移动端换行
- **测试**：npm test 30 个（含 avatar 变化形状回归）；会话累计 35+ 签名提交


## 2026-08-30（深夜 4-5） 自主开发第四-十二轮（收藏闭环/反馈闭环/搜索/健壮性/测试）

- **收藏闭环**：favorite-add/remove body 解析真 bug 修复（JSON.parse(req.body) 恒空→readJsonBody，此前收藏功能整体不可用）；world 分组动态发现（不再硬编码 worlds0）；favorite_world 满组自动降级（默认组满→顺序尝试下一组）；模型/好友收藏切换（AvatarsView ⭐ + UserDialog 收藏好友）；收藏夹移动分组 + 分组管理（重命名/可见性）；变更后缓存失效
- **推荐反馈闭环**：world/rate（rate_world 👍/👎）+ world/visited 路由；RecommendView 卡片按钮 + 已逛角标；WorldDialog 随处反馈
- **搜索**：新增模型类型（实测 VRChat /avatars 需 marketplace=all）；搜索历史（localStorage 最近 8 条）
- **关注闭环**：watchlist 路由 + 动态页只看关注 + 好友页关注 tab + 👁 标识（动态行/右侧栏 5 处）+ UserDialog 关注按钮 + 只看此人筛选
- **健壮性**：SSE 新事件重复（时间窗去重）；refreshTracked 并发闸；头像 diff file-id 归一化；moderation/delete 安全模式拦截；community-events in-flight 去重 + 60s 超时；trackedChanges previousAvatarImageUrl 漏映射（测试抓出）；legacy parseLoc friends+/invite+（回归测试抓出）
- **运维**：backup-prod.sh 归档层（10 份）+ 魔数头自验证 + 恢复验证实测（integrity ok 数据一致）
- **测试**：npm test 32 个（dashboard 服务/热图 rangeDays/friends+ 解析/实例标签）；会话累计 48 提交全部签名

## 2026-08-30（深夜 6） 自主开发第十三-十五轮（周报增强/足迹时长/浏览器通知/巡检工具）

- **周报「好友群组活跃」区**：friendGroupCalendar（好友常去群组：好友数/活动数/世界数，点击打开群组）——真实 28 群组
- **足迹页游玩时长**：recentWorlds 会话切分统计 30 天分钟（gameSessions 同口径），前端显示；修复数组契约双嵌套 bug（部署验证抓出）；回归测试
- **浏览器通知提醒**：头部铃铛开关（localStorage 记忆），SSE 收到好友请求/邀请/群组邀请时桌面 Notification（10s 关闭）
- **verify-container.sh 扩展**：覆盖全部 16 条功能路由（含慢路由 70s 超时）
- 容器日志巡检：无错误、自动备份正常、追踪刷新 9/9、收藏 110 个

## 2026-08-30（清晨 7） 自主开发第十六轮（追踪功能闭环 + 用户反馈迭代）

- **非好友追踪 UI 重做**（用户反馈驱动）：卡片化列表 + 添加追踪面板（搜索用户→加入，幂等+立即刷新）+ 移除追踪（removed_at 标记持久化，种子不再复活）+ 打开资料/移除带文字按钮
- **修复：自己误入追踪列表**——启动早期 /auth/user 失败时 selfId 为空；改为事件表推导（user-location/user-update 只会是自己的事件）+ API 兜底 + 启动清理 + 列表过滤 + 添加拒绝，四层防护
- **在线状态显示**：刷新循环落库 status/statusDescription/location（迁移加列）；列表绿色圆点+状态徽章（在线/加入我/问我/忙碌/离线，对齐好友页）；在线优先排序
- **动态页「只看追踪」筛选**：trackedIds 加载 + 望远镜 chip，与只看关注/只看我并列；空态引导
- **变化时间线类型筛选**：全部/头像/简介/状态 chips
- **X 抓取尝试与回退**：chromium+Xvfb+代理基建验证可用，但 2026 X 全匿名通道封锁（Nitter 全灭/GraphQL 404/登录墙）——已回退基建保留 UI，文档注明环境限制


## 2026-08-30（清晨 8-9） 自主开发第二十一-二十五轮（媒体视图/功能联动/性能预热）

- **媒体视图**：新增「相册」（VRChat Plus 照片网格+大图预览+打开原图）与「画廊」（资料展示图）双 tab 页；WorldDialog 新增「照片」tab（按 worldId 过滤相册，世界↔媒体联动）
- **功能联动**：动态页事件详情「追踪此人」快捷（非好友一键加入追踪，trackedIds 实时更新）；动态页「只看追踪」筛选（望远镜 chip）+ 追踪列表在线优先排序 + 时间线类型筛选（全部/头像/简介/状态）
- **追踪功能闭环**（用户反馈迭代）：UI 重做（卡片化+管理）+ 自己误入修复（事件表推导 selfId 四层防护）+ 在线状态显示（圆点+徽章）+ 移除持久化（removed_at）
- **性能**：慢路由启动预热（community-events 48s→4ms、recommend-worlds 11s→2ms 重启后首访秒开）
- **通知**：全部已读按钮（see-all 端点接 UI）
- 会话累计 87 提交全部签名；CI 全绿

## 2026-08-30（上午 10） 第二十六-二十八轮（足迹排序/相册世界筛选）+ 会话交接

- 足迹页排序选项（最近/次数/时长）
- 相册按世界筛选 chips（照片最多的前 8 世界+数量）
- **会话交接**：docs/HANDOFF-2026-08-30.md（当前状态/运维铁律/开发约定/PTC 说明/接手清单）——任何新会话（含 PTC）接手的第一入口

## 2026-08-30（上午 11） 第二十九-三十轮（相册预览导航/直接ID添加）

- 相册/画廊预览对话框：上一张/下一张导航（计数+循环）
- 追踪添加面板：支持直接粘贴 userId（搜索不到时）
- verify-container.sh 覆盖 prints/gallery 路由（16 项功能路由全检）
- 会话累计 91 提交全部签名

## 2026-08-30（中午） 第三十一-三十三轮（好友备注/弹窗追踪/事件JSON）

- 好友卡显示备注（memo）+ 搜索支持备注关键词
- UserDialog 非好友加「追踪/取消追踪」按钮（追踪三入口闭环：事件详情→资料弹窗→追踪页）
- 事件详情「复制JSON」按钮
- 运维巡检：10 份归档备份/容器 66MB/DB 9.6M/磁盘 188G 空闲——健康
- 会话累计 96 提交全部签名

## 2026-08-30（下午） 第三十四-三十五轮（设为当前模型/创建房间）

- 「我的模型」页「设为当前模型」按钮（selectAvatar API，非破坏性）
- 世界弹窗「创建房间」：类型（私密/仅好友/群组/公开）+ 区域（jp/us/eu），create_instance 工具，结果可复制
- events 路由性能核对：36ms/50、102ms/200——无需优化
- 会话累计 99 提交全部签名

## 2026-08-30（下午 2） 第三十六轮（世界网页版外链）

- 世界弹窗世界 ID 行加「网页版」外链（vrchat.com/home/world/{id}，方便分享/查看）
- 会话累计 101 提交全部签名

## 2026-08-30（下午 3-4） 第三十七-四十一轮（素材/公告视图 + 追踪修复）

- **BOOTH「素材」视图**（第 23 个）：搜索网格（封面/价格/店铺）+ 详情 Dialog（收藏/标签/在售）+ BOOTH 外链 + 最近搜索 chips
- **「群组公告」视图**（第 24 个）：跨群组公告历史时间线（WS 推送的 group.announcement 汇总）+ 群组筛选 + 搜索 + 展开全文 + 新公告红色「新」徽标（localStorage 基线）
- **追踪修复**：刷新循环过滤已移除用户（removed_at=''，省限流调用+不再记录变化）
- 视图累计 24 个；会话累计 107 提交全部签名

## 2026-08-30（下午 5） 目标配置：全自动 100 轮

- 用户指令：goal 全自动 100 轮直到手动停止 + 自动优化提示词
- 已执行：max_goal_rounds 60→100；目标提示词优化（聚焦持续优化方向 + 五条铁律 + 停止/反馈规则）

## 2026-08-30（下午 5-6） 第四十二-四十五轮（素材收藏/媒体删除）

- BOOTH 素材：本地收藏（星标+收藏筛选，localStorage）+ 详情收藏按钮 + 收藏卡详情
- 相册/画廊：删除照片/图片（remove_print/remove_gallery_image，安全模式拦截 🔒）——媒体增删查闭环
- verify-container 扩展 20 条路由全检
- 会话累计 114 提交全部签名

## 2026-08-30（下午 6-7） 第四十六-四十八轮（键盘导航/好友位置/测试补强）

- 相册预览键盘导航（左右切换/Esc 关闭）
- 好友卡显示当前位置世界（🌐 可点击打开世界详情）
- 测试补强：trackedAdd 幂等/拒绝自己 + trackedRemove 移除标记（npm test 36 全绿）
- 运维抽查：备份可恢复（integrity ok/4000 事件）、日志无真错误
- 会话累计 118 提交全部签名

## 2026-08-30（傍晚） 第四十九-五十三轮（空态引导/视图数/备注/徽标）

- 素材收藏空态引导；足迹卡显示世界备注文字；视图清单更新为 24 个
- 全视图模式扫描：v-model 表达式/模板 .value 误用 0 问题
- 导航「通知」未读徽标：计数端点 + SSE 实时累加 + 查看后重算（徽标闭环）
- 运维：DB 4010 事件、磁盘 185G、容器 82MB——健康
- 会话累计 124 提交全部签名

## 2026-08-30（夜） 第五十四-五十五轮（SSE徽标校准/作者世界）

- 通知徽标：SSE 重连成功后重算（断开期间计数不失准）——徽标闭环完整
- 世界弹窗「其他世界」：作者名旁懒加载该作者发布的世界（get_worlds_by_author，封面/收藏/点击打开）
- 会话累计 127 提交全部签名

## 2026-08-30（深夜） 第五十六-五十八轮（预览世界/公告徽标/X空态）

- 相册预览显示照片所在世界（可点击）；导航「公告」新公告徽标（localStorage 基线 + 查看同步清除）
- groupAnnouncementsAll 回归测试（npm test 37 全绿）
- X 推荐空态引导区分场景（无博主/抓取受限如实说明）
- 会话累计 132 提交全部签名

## 2026-08-30（深夜 2） 第五十九-六十二轮（自动刷新修复/相对时间/只看未读）

- 修复玩家页 30 秒自动刷新缺失（文案声称但未实现）；全视图「自动刷新」审计干净
- utils 新增 reltime 相对时间；足迹卡/追踪页最近变化改用相对显示
- 通知页「只看未读」筛选
- 会话累计 137 提交全部签名

## 2026-08-30（凌晨 3） 第六十三-六十六轮（收藏星标/公告复制/群组预览/只看世界）

- 足迹卡收藏星标（world_cache.favorited）；公告全文「复制全文」
- 群组行最新公告预览（懒加载）；动态页「只看此世界」筛选（世界详情处过滤）
- 会话累计 142 提交全部签名

## 2026-08-30（凌晨 4） 第六十七-六十九轮（只看收藏/世界名复制）

- 足迹页「只看收藏」筛选（配合星标）；「只看此世界」chip 显示世界名
- 世界弹窗标题「复制世界名」按钮
- 会话累计 146 提交全部签名

## 2026-08-30（凌晨 5） 第七十-七十一轮（401提示/公告日期分组）

- api.js 401 明确提示（会话过期/服务未就绪自愈）；公告时间线按日期分组
- 会话累计 149 提交全部签名

## 2026-08-30（凌晨 6） 第七十二-七十三轮（追踪计数/搜该店）

- 「只看追踪」chip 显示追踪人数；素材详情「搜该店」（BOOTH 按店铺名搜索）
- 运维巡检：10 份备份/近 1h 无真实错误/磁盘 185G
- 会话累计 152 提交全部签名

## 2026-08-30（早上 7） 第七十四-七十五轮（未读高亮/导出收藏）

- 通知未读行高亮 + 蓝点；素材「导出收藏」清单复制
- 备份抽查：integrity ok/4020 事件/9 追踪
- 会话累计 155 提交全部签名

## 2026-08-30（早上 8） 第七十七-七十八轮（相册/画廊上传）

- 相册「上传照片」+ 画廊「上传图片」：浏览器 base64 → 容器临时文件 → upload_print/upload_gallery_image → 清理
- 媒体页增删查上传完整闭环（VRChat 侧 403 为账号 Plus 权限问题，管线已验证）
- 会话累计 159 提交全部签名

## 2026-08-30（上午 9） 第七十九-八十轮（动态导出/最近搜索清空）

- 动态页「导出当前筛选」（JSON 下载）；素材最近搜索「清空」
- 会话累计 162 提交全部签名

## 2026-08-30（上午 10） 第八十一-八十二轮（群组/世界链接复制）

- 群组行「复制群组链接」；世界弹窗「复制网页链接」
- 会话累计 165 提交全部签名

## 2026-08-30（上午 10-11） 第八十三轮（玩家链接复制/只看收藏计数）

- 玩家行「复制玩家链接」；动态页「只看收藏」chip 显示收藏好友数
- 会话累计 167 提交全部签名

## 2026-08-30（中午） UI 主线启动（用户指令：围绕 UI 统一/好用/好看，goal 100 轮）

**UI 统一批次（第 84 轮，6 批）**：
1. chip/empty/loading-mini/star 收敛为全局基元（21 视图去重，36 处 .chip → 全局唯一）
2. ::selection/链接/按钮字体/prefers-reduced-motion + h2 标题 [class$="-head"] 全局化（19 视图去重）
3. 移动端抽屉导航分组（核心/内容/发现/数据/管理）
4. 桌面侧栏导航同分组
5. 输入框 [class$="-input"] 全局化（6 视图去重）
6. Dialog/Drawer/Toast 圆角统一（--radius token）

- 全部 npm test 37 绿 + doc-drift 干净 + 部署验证
- 会话累计 173 提交全部签名

## 2026-08-30（中午 12） UI 轮 85（排印/卡片动效/铃铛红点）

- --font-mono token 定义 + .mono 全局化（5 视图去重）
- 网格卡片悬停微浮起（1px+柔影，6 类卡片共用）
- 头部通知铃铛未读红点（与导航徽标联动）
- 会话累计 181 提交全部签名

## 2026-08-30（中午 12-1） UI 轮 86（类型图标体系）

- 动态页 21 类事件类型图标、通知页类型图标（当前+历史）、日志页级别图标——三处标签统一「图标+文字」体系
- 会话累计 186 提交全部签名

## 2026-08-30（下午 1） UI 轮 87（回顶按钮/游玩时长条）

- 全局悬浮「回到顶部」（主滚动容器捕获滚动 >400px 出现，平滑回顶，移动端适配）
- 足迹卡游玩时长迷你条（accent 渐变，相对最长世界）
- 会话累计 189 提交全部签名

## 2026-08-30（下午 2） UI 轮 88（收藏排序/偏好持久化）

- 素材收藏按名称排序（中文感知）；足迹排序偏好 localStorage 持久化
- 会话累计 192 提交全部签名
