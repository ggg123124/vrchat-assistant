# Web Dashboard

> 本文档说明 `web-dashboard` 官方插件的设计边界与使用方式。

## 定位

Dashboard 是远程 24 小时监控界面，面向部署在 NAS、路由器或 Docker 中的 `vrchat-assistant` 服务。它不依赖本机运行 VRChat 客户端，不读取 `output_log.txt`，也不提供 SteamVR/桌面启动功能。

界面采用 Monitor / Operate 混合布局：侧栏导航、服务状态指标、最近事件流和好友列表。右侧好友栏按在线、离线、收藏&星标分组；在线与离线来自好友快照，收藏组仅在后端 DTO 提供收藏字段时展示记录。后续页面可以继续加入世界、通知、MCP 工具和运维面板。

## 访问

服务启动后访问：

```text
http://<服务地址>:8799/dashboard
```

Dashboard 路由复用核心 HTTP 鉴权。部署了 `auth-guard` 时，浏览器请求需要携带：

```text
Authorization: Bearer <VRC_MONITOR_AUTH_TOKEN>
```

直接在地址栏访问时，建议通过前置反向代理注入鉴权 Header，或仅在可信局域网使用。不要把 Token 写进前端源码、URL、提交记录或截图。

## 当前接口

| 路径 | 用途 |
|------|------|
| `GET /dashboard` | Dashboard 页面 |
| `GET /api/dashboard/overview` | 认证、WebSocket、好友、数据库、插件和运行时长摘要 |
| `GET /api/dashboard/friends?limit=100` | 好友当前快照 |
| `GET /api/dashboard/events?limit=50` | 最近事件 |
| `GET /api/dashboard/friend-events?userId=usr_...&limit=12` | 指定好友近期事件 |
| `GET /api/dashboard/profile-changes?userId=usr_...&limit=20` | 指定好友的 Avatar / Bio / 状态等资料变更 |
| `GET /api/dashboard/groups?userId=usr_...` | 指定好友加入的群组 |
| `GET /api/dashboard/notifications?limit=30&types=invite` | 当前账号通知收件箱，支持类型筛选和分页 |
| `POST /api/dashboard/notifications/see` | 标记通知已读，JSON body 为 `{ "notificationId": "..." }` |
| `GET /api/dashboard/stats?days=7` | 活动统计：当前在线、按类型/按天聚合、活跃好友 Top |
| `GET /api/dashboard/stream` | SSE 事件流：核心事件落库后实时推送轻量事件 DTO（含心跳保活） |
| `GET /api/dashboard/nickname?userId=usr_...` | 查询好友本地备注/昵称映射 |
| `POST /api/dashboard/nickname` | 设置/清除好友本地备注，JSON body 为 `{ "userId": "...", "nickname": "...", "displayName": "..." }` |
| `GET /api/dashboard/search?q=...&type=users|worlds|groups|avatars&limit=20` | 搜索用户 / 世界 / 群组 / 模型（模型走 `/avatars?search=&marketplace=all` API） |
| `GET /api/dashboard/favorites?type=worlds|groups&limit=30` | 收藏世界（按分类分组）/ 收藏分组，复用 `get_my_favorite_worlds` / `get_my_favorite_groups` |
| `GET /api/dashboard/tracked?limit=200` | 非好友追踪列表（tracked_non_friends 表） |
| `GET /api/dashboard/tracked-changes?userId=usr_...&limit=20` | 非好友 bio/状态/头像变化时间线（本地 events 表，含前后值对比） |
| `POST /api/dashboard/tracked/refresh` | 手动触发非好友资料刷新（fire-and-forget，立即返回） |
| `GET /api/dashboard/weekly-report?days=7` | 周报（复用 `get_weekly_report` 工具：活跃概况/每日足迹/世界Top/同屏伙伴/群组活动/上线规律） |
| `GET /api/dashboard/x-worlds?limit=50` | X 博主推荐世界（本地 x_world_recommendations 表 + 博主清单） |
| `POST /api/dashboard/moderation/delete` | 解除屏蔽/静音（`unplayerModerate`，按 userId+type；安全模式下拦截） |
| `POST /api/dashboard/world/rate` | 世界推荐反馈：评分（`rate_world` 1/-1/0，影响推荐引擎） |
| `POST /api/dashboard/world/visited` | 标记世界已逛（`mark_world_visited`，减少后续推荐） |
| `POST /api/dashboard/x-creators` | 添加 X 博主（`x_add_creator`） |
| `POST /api/dashboard/x-creators/scan` | 触发 X 博主推荐抓取（fire-and-forget） |
| `POST /api/dashboard/x-creators/remove` | 移除 X 博主（`x_remove_creator`；安全模式下拦截） |
| `GET/POST /api/dashboard/watchlist` + `POST /api/dashboard/watchlist/remove` | 关注名单（添加/移除；remove 安全模式下拦截） |
| `POST /api/dashboard/favorites/move` | 收藏世界移动分组（move_world_group；安全模式下拦截） |
| `POST /api/dashboard/favorites/group` | 收藏夹分组管理（update_favorite_group：重命名/可见性；非破坏性） |
| `GET /api/dashboard/prints` | 相册（VRChat Plus 照片，get_prints） |
| `GET /api/dashboard/gallery` | 画廊（资料展示图，get_gallery_images） |

前端通过 SSE（`/api/dashboard/stream`）实时接收新事件（节流刷新，≤5 秒一次），并保留 30 秒轮询作为兜底。对齐 VRCX 的展示能力：事件流带表头（时间/类型/玩家/详细信息/世界），事件行的世界列可点击打开世界资料弹窗（封面/名称/作者/简介）；事件与资料页解析实例类型与区域（如 Friends · JP）；玩家资料 Inspector 提供资料、活动、世界、Avatar、群组标签，并支持本地备注查看/设置；搜索工作区支持用户 / 世界 / 群组检索，用户结果可打开资料、世界结果可打开世界资料；收藏&星标工作区按分类展示收藏世界（点击打开世界资料）与收藏分组。通知工作区提供读取、类型筛选、分页和标记已读；图表工作区提供在线热图、每日活动量、事件类型分布与活跃好友统计（7/30/90 天切换）。事件采集始终由核心 WebSocket push 链路负责。

> 2026-08-30 深夜新增/增强：搜索支持**模型**类型（`/avatars?search=&marketplace=all`）+ **搜索历史**（localStorage 最近 8 条）；足迹页显示 **30 天游玩时长**（会话切分口径，与 worldHistory/gameSessions 统一）；周报新增**好友群组活跃**区；**浏览器通知提醒**（头部铃铛开关，SSE 收到好友请求/邀请/群组邀请时桌面 Notification）；动态页**只看此人/只看我/只看关注**筛选 + 空态引导；收藏闭环完整（增/删/移/分组重命名/可见性）；推荐反馈闭环（👍/👎/已逛，RecommendView + WorldDialog 随处可用）；**SSE 新事件时间窗去重**修复；动态/周报/屏蔽/玩家视图移动端适配 100% 覆盖。

> 2026-08-30 起侧栏 **24 个视图全部实装**（动态/好友/非好友追踪/收藏/日志/玩家/通知/模型/足迹/媒体/素材/公告/X推荐/推荐/群组/活动/图表/周报/屏蔽/工具/搜索/直接打开/相册），不再有占位页；新增后端路由 `GET /api/dashboard/tracked`（非好友追踪列表）、`GET /api/dashboard/tracked-changes`（非好友变化时间线）、`POST /api/dashboard/tracked/refresh`（手动刷新）、`GET /api/dashboard/weekly-report`（周报）、`GET /api/dashboard/x-worlds`（X 博主推荐）、`GET /api/dashboard/recommend-worlds`（多源世界推荐）、`GET /api/dashboard/my-groups`（我的群组）、`GET /api/dashboard/community-events`（社区活动聚合）与 `POST /api/dashboard/moderation/delete`（解除屏蔽/静音）。Dashboard 数据服务（`dashboard.*`）实现在核心 `core/dashboard-services.js`（2026-08-30 从 start-monitor.js 下沉，owner=`core`），非好友头像变化事件由 start-monitor.js `_refreshTrackedNonFriends` 每小时 diff 落库；周报/推荐/群组/活动路由带 Map+TTL 缓存（5-10 分钟）。

## 插件边界

- Dashboard 页面与接口位于 `plugins/official/web-dashboard/`。
- 插件采用**单插件、内部模块化**结构，不再额外实现一套子插件加载器：
  - `index.js`：插件入口、核心数据路由、SSE 和生命周期组合。
  - `server/http.js`：JSON/HTML 响应、参数限制、JSON 请求体解析。
  - `server/state.js`：缓存状态、TTL 和缓存读写。
  - `server/routes/search.js`：搜索与本地备注路由。
  - `server/routes/favorites.js`：好友、世界、Avatar 收藏路由。
  - `server/routes/avatars.js`：屏蔽管理与 Avatar 路由。
  - `server/routes/social.js`：通知、玩家资料、资料变更与群组路由。
  - `client/dashboard.css`：前端样式（注入到 `/dashboard` 页面）。
  - `client/js/util.js`：前端纯工具函数——转义、时间/日期、状态灯、信任徽章、位置解析、世界名、事件类型、通知类型等（注入到 `/dashboard` 页面）。
  - `client/js/views.js`：前端视图渲染——各工作区加载/渲染、事件行、好友行、图表、弹窗、玩家资料（注入到 `/dashboard` 页面）。
  - `client/js/app.js`：前端主逻辑——状态、`render`/`load` 调度、事件绑定、SSE、初始化（注入到 `/dashboard` 页面；三个 JS 文件拼接进同一 `<script>` 块，`util → views → app` 顺序）。
- 内部路由模块通过 `registerXxxRoutes(api, state)` 注册，不是独立 Hermes 插件；所有模块共享同一个 `register(api)` 生命周期和插件 API。
- 核心只提供通用 HTTP 路由注册、鉴权顺序和只读 Dashboard 服务。
- 插件通过 `api.http.registerRoute()` 注册路由，通过 `api.consume('dashboard.*')` 读取数据。
- Dashboard 数据服务（`dashboard.*`，19 个 + SSE 总线）实现在核心 `core/dashboard-services.js`（`registerDashboardServices`，owner=`core`，2026-08-30 从 start-monitor.js 下沉）——插件只消费不实现（实现需直读核心表，插件契约禁止）。
- 插件不导入核心模块、不读取数据库文件、不读取凭据或 Token。
- 路由会随插件卸载/热重载清理。

## 性能机制

- **后端缓存 TTL**：慢接口（VRChat 限流 API）结果缓存——收藏世界 30 分钟、我的模型/屏蔽管理 30 分钟、收藏好友 10 分钟、首页收藏位置 5 分钟；命中缓存时秒回（实测从 ~3-8s 降到 ~13ms）。
- **后端错峰预热**：插件注册后 30 秒启动，每 10 分钟一轮，逐项间隔 15 秒提前拉取我的模型 / 屏蔽管理 / 收藏好友填充缓存（避免集中占满限流队列）；用户首次打开即命中缓存。
- **我的模型 stale-while-revalidate**：avatars 接口在有旧缓存但过期时，先秒回旧数据、后台异步刷新，任何场景都不白等；同时 `/auth/user`（uid/当前模型）缓存 5 分钟，冷缓存时省 1 个限流请求。
- **前端视图缓存**：`get()` 对慢视图接口（home/favorites/avatars/moderation/notifications/recent-worlds/stats）做 60 秒前端缓存——切走再切回时秒显旧数据并后台刷新；通知的标记已读 / 接受 / 拒绝等写操作后主动失效对应缓存，避免显示旧数据。轮询接口（overview/friends/events）不缓存，保持实时。
- **视图切换竞态保护**：`viewToken` 机制——切换视图后旧请求的异步响应若 token 不匹配则丢弃，不再出现“切到模型页后被收藏结果覆盖跳回”的问题。

## 验证

无凭据冒烟检查：

```bash
node --check core/http-server.js
node --check core/plugin-api.js
node --check core/plugin-loader.js
node --check plugins/official/web-dashboard/index.js
node --check plugins/official/web-dashboard/server/http.js
node --check plugins/official/web-dashboard/server/state.js
node --check plugins/official/web-dashboard/server/routes/search.js
node --check plugins/official/web-dashboard/server/routes/favorites.js
node --check plugins/official/web-dashboard/server/routes/avatars.js
node --check plugins/official/web-dashboard/server/routes/social.js
```

模块化插件注册冒烟应确认：23 条路由、无重复路由，并且 `register(api)` 返回 disposer 函数。该检查使用临时 mock 脚本执行，验证后删除，不作为运行时文件提交。

需要完整注册表检查时，先按项目要求安装 Node 依赖，再运行 `node test-registry.mjs` 和 `python scripts/check-doc-drift.py --json`。
