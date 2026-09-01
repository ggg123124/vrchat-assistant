# vrchat-assistant 代码库调研与重构建议报告

> 调研范围：`ggg123124/vrchat-assistant` 仓库，main 分支，只读分析。  
> 统计口径：`find` + `wc -l`，排除 `node_modules/.git/tmp/backups/data/img_cache/pdf/downloads/Temp/asset`。  
> 架构依据：`ARCHITECTURE.md`、`DEVELOPMENT.md`、`AGENTS.md`、`core/tool-order.json`、`test/test-registry.mjs`、`test/test-storage-snapshot.mjs`。

---

## 1. 调研概况

### 1.1 仓库结构与技术栈

项目为 **vrc-monitor**（VRChat 监控/数据分析服务），Node.js ESM 单进程服务，核心架构：

- **入口**：`start-monitor.js`（787 行，承担启动流程、服务注册、WS 刷新、定时任务）
- **核心层 `core/`**：存储、认证、WebSocket、限流、工具注册表、插件加载器
- **核心工具 `core/tools/`**：9 个核心 MCP 工具文件
- **插件层 `plugins/official/`**：9 个官方插件（events/favorites/groups/media/planet/recommend/world-kb/x-creators/web-dashboard）
- **脚本 `scripts/`**：一次性迁移/运维脚本
- **前端**：`plugins/official/web-dashboard/`（含旧版 Vue 运行时 + 新版 Vite/PrimeVue UI）

技术栈：

| 依赖 | 用途 |
|------|------|
| `better-sqlite3` | SQLite 原生绑定，WAL 模式 |
| `ws` | VRChat WebSocket pipeline |
| `https-proxy-agent` | HTTP/WS 代理回退 |
| `playwright` | X 世界抓取浏览器通道 |

### 1.2 语言分布与代码规模

按扩展名统计源码（已排除目录）：

| 扩展 | 文件数 | 行数 |
|------|--------|------|
| `.js` | 79 | 22,406 |
| `.vue` | 31 | 7,086 |
| `.mjs` | 21 | 3,700 |
| `.py` | 12 | 3,059 |
| `.css` | 2 | 2,318 |
| `.sh` | 1 | 140 |
| **合计** | **146** | **38,709** |

仓库全部文件（含 markdown/docs/config）约 241,491 行，源码 38,709 行。

`core/tool-order.json` 当前登记 **104 个 MCP 工具**（核心工具 + 插件工具），但 `test/test-registry.mjs` 仍写死校验数量为 95，存在测试断言与现状的漂移，需在重构前同步更新。

---

## 2. 大文件清单

按 `wc -l` 降序列出所有 >400 行的源码文件，标注归属域：

| 行数 | 文件 | 归属域 |
|------|------|--------|
| 1936 | `plugins/official/web-dashboard/client/dashboard.css` | plugins / dashboard 前端 |
| 1225 | `plugins/official/web-dashboard/index.js` | plugins / dashboard 后端路由 |
| 1156 | `core/dashboard-services.js` | core / dashboard 数据服务 |
| 1134 | `core/fetch-x-worlds.js` | core / X 世界抓取 |
| 1046 | `plugins/official/web-dashboard/client/js/vue/views.js` | plugins / dashboard 前端 |
| 1032 | `plugins/official/web-dashboard/ui/src/views/FeedView.vue` | plugins / dashboard 前端 |
| 931 | `plugins/official/events/index.js` | plugins / 社区活动 |
| 915 | `plugins/official/web-dashboard/client/js/vue/dialogs.js` | plugins / dashboard 前端 |
| 787 | `start-monitor.js` | 根目录 / 入口 |
| 785 | `core/tools/recommend.js` | core / MCP 推荐工具 |
| 772 | `vrchat-api.js` | 根目录 / API 客户端 |
| 744 | `scripts/migrate-vrcx0.mjs` | scripts / 一次性迁移 |
| 713 | `core/tools/events.js` | core / MCP 事件工具 |
| 671 | `plugins/official/favorites/index.js` | plugins / 收藏 |
| 632 | `core/recommend-worlds.js` | core / 推荐引擎 |
| 581 | `plugins/official/web-dashboard/ui/src/store.js` | plugins / dashboard 前端 |
| 563 | `core/tools/misc.js` | core / MCP 杂项工具 |
| 557 | `core/storage.js` | core / 存储层 |
| 547 | `core/plugin-loader.js` | core / 插件加载器 |
| 538 | `core/analytics/social.js` | core / 社交分析 |
| 524 | `hermes-plugin/process_manager.py` | hermes-plugin / 进程管理 |
| 509 | `scripts/agent-review.py` | scripts / 审核辅助 |
| 500 | `scripts/check-doc-drift.py` | scripts / 文档漂移检测 |
| 484 | `test/test-apis.mjs` | test |
| 477 | `plugins/official/web-dashboard/ui/src/components/WorldDialog.vue` | plugins / 前端 |
| 445 | `plugins/official/web-dashboard/ui/src/components/UserDialog.vue` | plugins / 前端 |
| 444 | `plugins/official/web-dashboard/ui/src/components/RightBar.vue` | plugins / 前端 |
| 423 | `plugins/official/groups/index.js` | plugins / 群组 |
| 417 | `plugins/official/web-dashboard/ui/src/views/TrackedView.vue` | plugins / 前端 |
| 401 | `plugins/official/media/index.js` | plugins / 媒体 |

---

## 3. 各主要大文件分析

以下对 >700 行的文件做职责与问题分析。

### 3.1 `core/dashboard-services.js`（1156 行）

**职责**：为 web-dashboard 插件提供 `dashboard.*` 核心服务（snapshot/friends/events/gameSessions/world/userProfile 等约 25 个服务）。

**问题**：

- **严重违反单一职责**。一个文件同时包含：
  - 状态快照（`dashboard.snapshot`）
  - 好友列表查询（`dashboard.friends`）
  - 动态事件流（`dashboard.events`）
  - 游戏会话切分（`dashboard.gameSessions`）
  - 世界详情与实例（`dashboard.world`、`dashboard.worldInstances`）
  - 用户资料聚合（`dashboard.userProfile`）
  - 非好友追踪（`dashboard.trackedNonFriends`）
  - 热力图统计（`dashboard.activityHeatmap`）
- **重复逻辑**：游戏会话切分算法在 `dashboard.gameSessions`（91-134 行）、`dashboard.recentWorlds`（519-548 行）、`dashboard.activityHeatmap`（764-796 行）、`dashboard.worldHistory`（836-866 行）四处独立实现，逻辑几乎相同（进入世界开段、offline/traveling 关段、同世界延续）。
- **内联公共逻辑未提取**：
  - `avatarThumb`（86-90 行）本可复用给所有头像 URL 转换场景；
  - `parseLocInfo`（224-244 行）与 `core/server-context.js` 的 `parseLocation` 职责重叠，却另写一套；
  - 事件 summary 文本（307-324 行与 500 行）在两个 service 里重复出现。
- **隐藏副作用**：`dashboard.events` 内部在返回结果后 fire-and-forget 调用 `ctx.rateLimiter.execute` 补全群组名、物品名、模型名（389-460 行）， mutates 本次返回数组元素，测试与行为等价回归困难。

### 3.2 `core/fetch-x-worlds.js`（1134 行）

**职责**：X 博主世界推荐抓取。包含 Nitter RSS、X SearchTimeline GraphQL、Playwright 浏览器三通道抓取，博主清单管理，推文解析，世界查询与入库。

**问题**：

- **三种不相关抓取机制耦合**：
  - Nitter RSS（223-254 行）
  - X SearchTimeline（262-379 行）
  - Playwright 浏览器（399-562 行）
  三者独立维护 `httpRequest`/`tryFetchWithProxy`/`resolveProxy`，与 `core/ws-manager.js`、插件 `events/index.js` 的网络工具重复。
- **解析与网络未分层**：`parseRss`/`parseSearchTimelineTweets`/`buildTweetFromBrowserItem` 与抓取循环混在一起；`extractWorldsFromTweetText` 同时做 URL 提取、世界名提取、作者名提取、三行格式解析，可拆。
- **可提取公共函数**：
  - `resolveProxy`（104-108 行）与 `events/index.js` 的 `resolveProxy` 逐行重复；
  - `tryFetchWithProxy`（184-204 行）与 `events/index.js` 的 `tryFetchWithProxy` 设计一致；
  - `normalizeName`（739-741 行）仅内部使用，但 world 搜索/推荐/收藏多处都可复用名称归一化；
  - `mapWorld`（864-877 行）对世界字段的转换与 `core/recommend-worlds.js`、`core/tools/events.js` 中对 VRChat world 对象的裁剪逻辑重复。

### 3.3 `plugins/official/web-dashboard/index.js`（1225 行）

**职责**：Dashboard 插件入口。注册约 40 条 HTTP 路由，覆盖首页、好友、世界、通知、收藏、X 世界、社区活动、相册等。

**问题**：

- **HTTP 路由与业务逻辑未分层**：index.js 直接写路由 handler，每个 handler 做参数校验、缓存、工具调用、错误处理。同构逻辑（如缓存包装、限流参数解析、`safeMode` 拦截）重复出现。
- **职责过多**：一个文件同时处理 dashboard HTML 服务、REST API、缓存策略（weeklyCache/recCache/evtCache/groupsCache）、上传临时文件、安全模式拦截。
- **可下沉到路由文件**：已有 `server/routes/*.js` 但 index.js 仍注册大量路由（search/favorites/avatars/social 等才拆出），剩余路由可按领域拆分。
- **缓存策略重复**：每个路由各自维护 TTL/去重（`evtInflight`、`weeklyCache`、`recCache`），可抽象为通用 `cachedCall` helper。

### 3.4 `core/tools/recommend.js`（785 行）

**职责**：`get_favorite_friends_locations`、`recommend_join`、偏好设置、选择学习。

**问题**：

- **三个独立 MCP 能力混在一起**：
  - 收藏夹位置查询（`handleGetFavoriteFriendsLocations`，163-460 行）
  - 推荐偏好/学习（`handleSetJoinPreference`、`handleGetJoinPreference`、`handleRecordJoinChoice`、`handleGetJoinLearning`，462-660 行）
  - 推荐加入（`handleRecommendJoin`，662-782 行）
- **评分系统与查询系统耦合**：`buildScoreContext`、`computeEntryScore`、`buildFamiliarityScorer`、`buildGroupMap` 都写在同一文件，但 `handleRecommendJoin` 和 `handleGetFavoriteFriendsLocations` 都需要它们。这些评分基础设施应抽到 `core/recommend-scoring.js`。
- **重复世界名查询**：`getWorldNameSafe` 在 `handleGetFavoriteFriendsLocations`（200-215 行）和 `handleRecommendJoin`（691-710 行）中几乎相同，与 `core/tools/events.js` 的 `handleGetWorldName` 也重复。
- **实例详情查询重复**：两处都通过 `/instances/${location}` 查玩家数/容量/填充率。

### 3.5 `core/tools/events.js`（713 行）

**职责**：事件/世界/周报的 MCP 工具集合。

**问题**：

- **工具表与 handler 实现分离不完整**：文件后半部分（410-713 行）全是 `tools` 数组定义，前半部分是 handler。虽然符合“自声明”模式，但 713 行内混合 13 个 handler 仍过大。
- **可拆分领域**：
  - 事件查询：`get_friend_events`/`get_recent_events`/`get_recent_cooplay`
  - 同屏分析：`get_friend_pair_meeting`/`get_friend_pair_screen`/`get_companions`
  - 世界信息：`get_world_name`/`get_worlds_by_author`/`set_world_note`/`get_world_history`
  - 周报：`get_weekly_report`
- `handleGetWeeklyReport`（270-407 行）同时做世界名解析、群组信息补全、同屏合并、日历组装，逻辑重，但已是编排层，拆分收益中等。

### 3.6 `core/tools/misc.js`（563 行）

**职责**：杂项 MCP 工具（系统状态、数据库统计、新世界扫描、关注名单、同屏、上线规律、昵称、备份、世界搜索等）。

**问题**：

- **“杂物间”式文件**：17 个 handler 涵盖系统、监控、世界 KB、关注名单、昵称、备份，毫无内聚。
- **明显应拆出的领域**：
  - 世界 KB 相关：`scan_new_worlds`/`get_new_worlds`/`rate_world`/`mark_world_visited`/`set_world_sleep`/`add_to_backlog`/`get_backlog`/`remove_from_backlog`
  - 关注名单/昵称：`get_watchlist`/`add_to_watchlist`/`remove_from_watchlist`/`get_nicknames`/`set_nickname`
  - 系统运维：`get_database_stats`/`get_server_status`/`backup_database`
- `handleScanNewWorlds`（36-155 行）做了 API 拉取、visited 判定、classify、upsert、推荐排序，应与 `core/new-worlds.js` 进一步解耦。

### 3.7 `start-monitor.js`（787 行）

**职责**：服务入口。加载 .env、初始化 ctx、DB、API、WS、插件、HTTP 服务、注册核心服务、定时任务。

**问题**：

- **已部分重构但仍有职责混杂**：`registerDashboardServices` 已抽出到 `core/dashboard-services.js`，但 `registerCoreServices` 仍在 `start-monitor.js` 中定义，包含 `storage.*`/`x.*`/`world.*`/`recommend.*` 服务注册。
- **WS 事件处理逻辑过长**：`_updateFriendState`、`_refreshOnlineState`、`_syncFriendAvatars` 写在入口文件。
- **启动流程与业务逻辑混合**：认证/OTP/TOTP、WebSocket、备份、HTTP 监听全部在主文件串联。

### 3.8 `core/recommend-worlds.js`（632 行）

**职责**：多源世界推荐引擎（local/planet/official 候选池、合并、反查、评分、过滤）。

**问题**：

- **PlanetVRC 抓取与推荐引擎耦合**：`_planetFetchHtml`/`_planetParseCards`/`_planetParseDetail`（29-132 行）本应是独立数据源模块。
- **评分函数过大**：`scoreCandidate`（448-500 行）集中了热度、Planet 信号、新鲜度、主题、作者画像、用户反馈多个维度。
- **依赖 `core/tools/misc.js`**：通过 `import { handleSearchWorlds } from './tools/misc.js'` 引用官方搜索，造成核心层反向依赖工具层，违反 `ARCHITECTURE.md` 中“核心层不收具体业务功能实现”的约定。

### 3.9 `vrchat-api.js`（772 行）

**职责**：VRChat REST API 客户端（登录、OTP、TOTP、Cookie 管理、请求、限流适配、错误处理）。

**问题**：

- **认证与 HTTP 客户端耦合**：登录流程、Cookie 刷新、API 请求在同一文件。
- **文件大但内聚度尚可**，拆分优先级低于上述文件，可作为 Phase 3 内容。

---

## 4. 跨文件重复与公共基础设施识别

### 4.1 同一“域”归类

| 域 | 涉及文件 |
|------|----------|
| **数据服务域（Dashboard）** | `core/dashboard-services.js`、`plugins/official/web-dashboard/index.js`、`plugins/official/web-dashboard/server/routes/*.js` |
| **X 世界抓取域** | `core/fetch-x-worlds.js` |
| **Dashboard 前后端** | `core/dashboard-services.js`（后端服务）+ `plugins/official/web-dashboard/*`（HTTP 路由+前端） |
| **推荐域** | `core/tools/recommend.js`、`core/recommend-worlds.js`、`core/tools/recommend-worlds.js` |
| **MCP 工具层** | `core/tools/*.js`、`core/registry.js`、`core/tool-order.json` |
| **事件处理域** | `core/tools/events.js`、`core/event-pipeline.js`、`core/analytics/social.js` |
| **世界知识库域** | `core/tools/misc.js`、`core/new-worlds.js`、`core/domains/world-store.js` |
| **社交分析域** | `core/analytics/social.js`、`core/tools/events.js`、`core/tools/recommend.js` |

### 4.2 跨文件重复逻辑

1. **HTTP 代理 + 抓取基础设施**
   - `core/fetch-x-worlds.js`：`resolveProxy`、`httpRequest`、`tryFetchWithProxy`
   - `plugins/official/events/index.js`：同名 `resolveProxy`、`httpRequest`、`tryFetchWithProxy`
   - **可沉淀**：`core/http-fetch.js` 提供 `resolveProxy()`、`httpRequest()`、`tryFetchWithProxy()`，供核心与插件通过 `api.consume('http.fetch')` 或独立 util 使用。

2. **location / instance 解析**
   - `core/server-context.js`：`parseLocation`（35-59 行）
   - `core/dashboard-services.js`：`parseLocInfo`（224-244 行）
   - `core/tools/recommend.js`：多处手工判断 `loc.type === 'hidden'` 等
   - **可沉淀**：扩展 `parseLocation` 输出统一字段（`instanceTypeDisplay`、`shortName`），Dashboard 直接使用，避免另写一套。

3. **头像缩略图 URL 转换**
   - `core/dashboard-services.js`：`avatarThumb`（86-90 行）
   - `plugins/official/web-dashboard/server/routes/avatars.js` 很可能也有类似逻辑
   - **可沉淀**：`core/avatar-utils.js` 提供 `avatarThumb(url)`、`avatarFileIdToAvatarId` 等。

4. **世界名缓存查询**
   - `core/tools/events.js`：`handleGetWorldName`（117-154 行）
   - `core/tools/recommend.js`：`getWorldNameSafe`（两处）
   - `core/recommend-worlds.js`：`resolveWorldId` 内部也会查 world_cache
   - **已部分封装**：`storage.getWorldName`/`storage.upsertWorld`，但 handler 层仍重复写缓存→API→upsert 流程。
   - **可沉淀**：`core/world-names.js` 的 `resolveWorldNames` 已存在，应让 `recommend.js` 直接复用，而不是重写 `getWorldNameSafe`。

5. **实例详情查询（玩家数/容量/填充率）**
   - `core/tools/recommend.js`：两处 `/instances/${location}`
   - `core/dashboard-services.js`：`dashboard.worldInstances`、`dashboard.instance`
   - **可沉淀**：`core/instance-utils.js` 提供 `fetchInstanceDetails(api, rateLimiter, location)`，统一返回 `{nUsers, capacity, type, region, ownerId}`。

6. **会话切分算法**
   - `core/dashboard-services.js` 四处重复实现
   - **可沉淀**：`core/analytics/session-utils.js` 提供 `segmentWorldSessions(rows)`，接受 events 行数组，返回会话段。

7. **名称归一化**
   - `core/fetch-x-worlds.js`：`normalizeName`
   - `plugins/official/favorites/index.js`：收藏分类/搜索也有类似 lower/trim 逻辑
   - **可沉淀**：`core/text-utils.js` 提供 `normalizeName`。

### 4.3 可沉淀的公共基础设施

| 新模块 | 职责 | 受益者 |
|--------|------|--------|
| `core/http-fetch.js` | 代理解析、node http(s) 请求、解压、回退 | `fetch-x-worlds.js`、`events` 插件、其他外部抓取 |
| `core/location-utils.js` | 统一 location 解析 + instance 详情查询 | `dashboard-services.js`、`recommend.js`、`server-context.js` |
| `core/avatar-utils.js` | 头像缩略图转换、fileId → avatarId 反查 | `dashboard-services.js`、前端路由 |
| `core/session-utils.js` | 世界会话切分（进入/离开/同世界延续） | `dashboard-services.js` 四处、周报 |
| `core/world-fetch-utils.js` | 缓存优先的世界详情获取（`getWorldNameSafe` 通用版） | `recommend.js`、`events.js`、`recommend-worlds.js` |
| `core/recommend-scoring.js` | 评分上下文、熟悉度、收藏夹权重、安静图判定 | `recommend.js`、`recommend-worlds.js` |
| `core/text-utils.js` | 名称归一化、HTML/XML 剥离 | `fetch-x-worlds.js`、`favorites` 插件 |

---

## 5. 重构优先级矩阵

排序规则：
- **价值高**：明显违反单一职责、拆出后提升可测试性、可被多个调用方复用。
- **风险低**：纯机械提取，不改函数签名/输出结构，不新增行为。

| 优先级 | 文件 | 价值 | 风险 | 建议动作 |
|--------|------|------|------|----------|
| **P0** | `core/dashboard-services.js` | 高 | 低 | 按服务拆分为 `dashboard/*.js`；提取 `session-utils`、`location-utils`、`avatar-utils` |
| **P0** | `core/tools/misc.js` | 高 | 低 | 按领域拆为 `core/tools/world-kb.js`、`core/tools/watchlist.js`、`core/tools/system.js` |
| **P1** | `core/fetch-x-worlds.js` | 高 | 中 | 拆为三通道抓取模块 + 提取 `http-fetch.js`；注意 Playwright 状态与回退语义 |
| **P1** | `core/tools/recommend.js` | 高 | 中 | 拆为 `recommend-join.js`、`join-preference.js`、`favorite-locations.js`；提取 `recommend-scoring.js` |
| **P1** | `plugins/official/web-dashboard/index.js` | 高 | 中 | 将剩余路由按领域拆入 `server/routes/*.js`；提取通用缓存包装 |
| **P2** | `core/tools/events.js` | 中 | 低 | 按事件查询/同屏/世界/周报拆为多个文件 |
| **P2** | `core/recommend-worlds.js` | 中 | 中 | 拆分 PlanetVRC 抓取模块；反向引用 `misc.js` 需解除 |
| **P3** | `start-monitor.js` | 中 | 高 | 抽出 `registerCoreServices` 到 `core/core-services.js`；抽出 WS 刷新逻辑 |
| **P3** | `vrchat-api.js` | 低 | 高 | 文件大但内聚，暂不动或仅做内部区域注释 |
| **不做** | `plugins/official/events/index.js` | 中 | 高 | 虽 931 行，但属于插件，功能完整且外部数据源多，拆分破坏可读性；仅提取 `http-fetch.js` 共享 |
| **不做** | 前端 `.vue`/`.css` | 低 | 中 | UI 大文件拆分收益低于后端；保持现状 |

---

## 6. 分阶段重构计划

**总原则：行为等价**。MCP 工具数量、顺序、定义、handler 路由、输出结构保持不变；所有拆分只做“代码搬家 + 机械提取”，不修改算法。

回归验证手段：
- `node test/test-registry.mjs`：校验 listTools 数量/顺序/handler 存在性。当前写死 95，需先改为 104 并与 `core/tool-order.json` 同步。
- `node test/test-storage-snapshot.mjs --check`：校验 storage 公共方法输入输出不变。
- 新增/修改测试：对拆出的 `http-fetch.js`、`session-utils.js` 等可用 `test/test-*.mjs` 做无凭据单元测试。
- 手动验证：启动 `node start-monitor.js`，调用 `get_server_status`、`recommend_join`、`x_world_digest`、`dashboard.events`（通过 dashboard HTTP）等关键路径。

### Phase 1：低风险纯提取/死代码清理（先做）

**目标**：提取纯函数型公共 helper，不改动 MCP 工具注册与输出。

| 动作 | 目标文件 | 新文件 | 拆分依据 | 风险 | 验证 |
|------|----------|--------|----------|------|------|
| 提取 HTTP 抓取基础设施 | `core/fetch-x-worlds.js`、`plugins/official/events/index.js` | `core/http-fetch.js`（导出 `resolveProxy`、`httpRequest`、`tryFetchWithProxy`） | 两者代码结构几乎一致；插件通过 `api.consume('http.fetch')` 或直接 import util（插件 loader 禁止 import core，故提供 service 或允许 util import 需评估） | 低 | 运行 `test/test-registry.mjs`；启动后 `x_scan_creators`、`fetch_community_events` 不报错 |
| 提取会话切分算法 | `core/dashboard-services.js` | `core/session-utils.js`（导出 `segmentWorldSessions(rows, opts)`） | 四处重复 | 低 | dashboard 的 game-sessions、recent-worlds、activity-heatmap、world-history 输出与重构前一致 |
| 提取 location/instance 公共函数 | `core/dashboard-services.js`、`core/server-context.js` | `core/location-utils.js`（导出 `parseLocInfo`、`parseInstance`、`formatInstanceTypeDisplay`） | `parseLocInfo` 与 `parseLocation` 重复 | 低 | `dashboard.events` 返回的 `instanceType`/`region` 一致；`recommend_join` 的 `instanceType` 一致 |
| 提取头像缩略图工具 | `core/dashboard-services.js` | `core/avatar-utils.js`（导出 `avatarThumb`、`extractAvatarNameFromFileId`） | 多处 inline | 低 | dashboard 好友头像 URL、userProfile avatarUrl 一致 |
| 清理死代码 | `core/storage.js` 迁移段 | 保持不动，仅删除确认无引用的迁移（如 world_kb.source 已删，继续清理注释） | 低风险 | 低 | `test-storage-snapshot.mjs --check` |

### Phase 2：提取公共 helpers / 基础设施

| 动作 | 目标文件 | 新文件 | 拆分依据 | 风险 | 验证 |
|------|----------|--------|----------|------|------|
| 提取评分基础设施 | `core/tools/recommend.js` | `core/recommend-scoring.js`（导出 `buildScoreContext`、`computeEntryScore`、`buildFamiliarityScorer`、`buildGroupMap`） | `recommend.js` 两处评分 + `recommend-worlds.js` 潜在复用 | 中 | `get_favorite_friends_locations`、`recommend_join` 的 `recommendScore`/`reasons` 完全一致 |
| 提取世界缓存优先查询 | `core/tools/recommend.js`、`core/tools/events.js` | `core/world-fetch-utils.js`（导出 `getWorldNameWithCache(ctx, worldId)`、`fetchWorldById`） | 多处重复写缓存→API→upsert | 中 | `recommend_join`、`get_favorite_friends_locations`、`get_world_name` 输出一致 |
| 提取实例详情查询 | `core/tools/recommend.js`、`core/dashboard-services.js` | `core/location-utils.js` 增加 `fetchInstanceDetails(ctx, location)` | 重复 /instances 调用 | 中 | 推荐分数中 instanceUsers 不变；dashboard worldInstances 输出不变 |
| 按领域拆分 `core/tools/misc.js` | `core/tools/misc.js` | `core/tools/world-kb.js`（新世界/评分/visited/backlog/search_worlds）<br>`core/tools/watchlist.js`（watchlist/nickname）<br>`core/tools/system.js`（status/stats/backup/online_pattern/companions） | 17 个 handler 跨多个领域 | 低 | `test-registry.mjs` 校验 104 个工具顺序与 handler 存在；`test-storage-snapshot.mjs` 校验 storage 行为 |
| 提取文本工具 | `core/fetch-x-worlds.js` 等 | `core/text-utils.js`（`normalizeName`、`stripHtml`、`decodeEntities`） | 多处相似处理 | 低 | X 抓取、收藏分类输出不变 |

### Phase 3：按域重组、拆分职责混叠单体

| 动作 | 目标文件 | 新文件 | 拆分依据 | 风险 | 验证 |
|------|----------|--------|----------|------|------|
| 拆分 `core/dashboard-services.js` | `core/dashboard-services.js` | `core/dashboard/services/snapshot.js`<br>`core/dashboard/services/friends.js`<br>`core/dashboard/services/events.js`<br>`core/dashboard/services/worlds.js`<br>`core/dashboard/services/user-profile.js`<br>`core/dashboard/services/tracked.js`<br>`core/dashboard/services/stats.js` | 25 个服务职责差异大 | 中 | dashboard 所有 `/api/dashboard/*` 端点返回与重构前一致；SSE stream 正常 |
| 拆分 `core/tools/recommend.js` | `core/tools/recommend.js` | `core/tools/favorite-locations.js`<br>`core/tools/join-preference.js`<br>`core/tools/recommend-join.js` | 三个独立 MCP 能力 | 中 | `test-registry.mjs` 通过；`recommend_join` 输出结构不变 |
| 拆分 `core/tools/events.js` | `core/tools/events.js` | `core/tools/event-query.js`<br>`core/tools/friend-pair.js`<br>`core/tools/weekly-report.js`<br>`core/tools/world-info.js` | 13 个 handler 跨四个领域 | 中 | 工具名/顺序不变；`get_weekly_report` 输出不变 |
| 拆分 `core/fetch-x-worlds.js` | `core/fetch-x-worlds.js` | `core/x-worlds/rss-fetcher.js`<br>`core/x-worlds/search-timeline-fetcher.js`<br>`core/x-worlds/browser-fetcher.js`<br>`core/x-worlds/creator-store.js`<br>`core/x-worlds/world-resolver.js` | 三通道抓取 + 博主管理 + 世界查询 | 中 | `x_scan_creators`、`x_world_digest` 输出不变；降级路径不变 |
| 拆分 Dashboard 路由入口 | `plugins/official/web-dashboard/index.js` | 按领域拆入 `server/routes/*.js`（worlds/recommend/tracked/media/system 等） | 40+ 路由集中在入口 | 中 | 所有 dashboard API 冒烟通过；首页 `/dashboard` 正常 |
| 解除 `recommend-worlds.js` 对 `tools/misc.js` 的依赖 | `core/recommend-worlds.js` | 官方搜索逻辑下沉到 `core/world-search.js` | 核心层反向依赖工具层，违反架构约定 | 中 | `recommend_worlds` 输出不变 |
| 抽出 `registerCoreServices` | `start-monitor.js` | `core/core-services.js` | 入口文件过厚 | 高 | 服务启动后 `api.consume('world.*')`、`api.consume('x.*')` 正常 |

---

## 7. 不建议重构清单

| 文件/目录 | 理由 |
|-----------|------|
| `plugins/official/web-dashboard/client/dashboard.css`（1936 行） | 纯 CSS 样式文件，拆分会导致选择器覆盖关系混乱，收益极低 |
| `plugins/official/web-dashboard/client/js/vue/views.js`、`dialogs.js` | 旧版 dashboard 前端，维护优先级低于新版 Vite UI；大改无意义 |
| `plugins/official/web-dashboard/ui/src/views/FeedView.vue`、`TrackedView.vue` 等 | 单文件组件按页面拆分已是合理粒度；再拆会过度设计 |
| `scripts/migrate-vrcx0.mjs`（744 行） | 一次性迁移脚本，生命周期短，不进入运行时；重构无价值 |
| `scripts/agent-review.py`、`scripts/check-doc-drift.py` | 运维/审核辅助脚本，独立运行；拆分无收益 |
| `hermes-plugin/process_manager.py` | Hermes 桌面插件进程托管，与核心服务解耦；保持独立 |
| `vrchat-api.js` | 虽 772 行，但内聚度高（单一 API 客户端）；拆分风险高且收益不明显 |
| `plugins/official/events/index.js` | 931 行但属于插件，外部数据源多且流程完整；强行拆分反而降低可读性；仅建议提取 `http-fetch` 共享 |

---

## 8. 与项目既有架构一致性

### 8.1 架构约定（来自 ARCHITECTURE.md / DEVELOPMENT.md）

- **核心只收 fix 与底座演进，新功能做插件**（DEVELOPMENT.md §1.1）。
- **核心工具在 `core/tools/*.js`**，自声明 `tools` 数组，经 `core/registry.js` 注册。
- **插件工具在 `plugins/official/<域>/index.js`**，默认导出 `register(api)`，经 `api.registerTool` 注册。
- **插件一律走 `api.*`，禁止 import core 内部模块、禁止触碰 `ctx`**（ARCHITECTURE.md 插件 API 层）。
- **新增 MCP 工具需同步 `core/tool-order.json` 与 `skills/vrc-monitor-agent/SKILL.md`**（DEVELOPMENT.md §1.1、§5）。
- **新增核心逻辑放 `core/` 下独立模块**，保持 `start-monitor.js` 薄入口（DEVELOPMENT.md §5）。

### 8.2 当前建议与架构的贴合点

- `core/tools/misc.js` 拆为 `world-kb.js`/`watchlist.js`/`system.js`：完全符合“核心工具按域组织”的约定，且无需改插件。
- `core/tools/recommend.js` 拆为 `favorite-locations.js`/`join-preference.js`/`recommend-join.js`：与 `plugins/official/recommend` 插件的“推荐域”概念对齐。
- `core/dashboard-services.js` 拆为 `core/dashboard/services/*.js`：符合“新增核心逻辑放 `core/` 下独立模块”的薄入口目标。
- `core/http-fetch.js`、`core/session-utils.js`、`core/location-utils.js` 等：属于“底座演进”类公共基础设施，允许进 core。
- `core/recommend-worlds.js` 解除对 `core/tools/misc.js` 的 import：符合核心层不应反向依赖工具层的约定。

### 8.3 需指出的冲突与注意事项

1. **`test/test-registry.mjs` 写死 95 个工具，与 `core/tool-order.json` 的 104 不一致**。  
   这是重构前必须修复的漂移，否则任何不减少工具数量的重构都会通过测试，但测试本身已与文档不同步。建议将测试改为动态读取 `tool-order.json` 长度。

2. **插件禁止 import core 内部模块 vs 提取 `core/http-fetch.js`**。  
   若将 `http-fetch.js` 作为 core 内部模块被插件 import，违反插件契约。解决方案：
   - 方案 A：将 HTTP 抓取作为核心服务 `http.fetch` 注册到 `loader.services`，插件通过 `api.consume('http.fetch')` 使用；
   - 方案 B：在 `core/plugin-api.js` 的 `api.vrchat.fetch` 之外新增 `api.http.fetch` 面，由核心统一提供代理/解压能力。  
   推荐方案 B，更贴合“插件 API 面”架构。

3. **`core/recommend-worlds.js` 当前 import `core/tools/misc.js`**。  
   这是现有代码违反架构约定的“架构债”，重构计划中 Phase 3 已列出解除该依赖。

4. **Dashboard 前端新旧两套并存**。  
   重构 Dashboard 后端路由时，应保持旧版 `?legacy=1` 入口可用；新 UI 优先但不可移除旧版支持。

5. **行为等价验证依赖 `test-storage-snapshot.mjs`**。  
   该测试覆盖 storage 公共方法，但 `dashboard-services.js` 内的服务未纳入快照。拆分 dashboard 服务后，建议补充 dashboard 服务的无凭据快照测试（可用内存 mock storage + 固定 seed events）。

---

## 9. 总结与下一步建议

**最优先执行（P0）**：

1. 修复 `test/test-registry.mjs` 中工具数量断言，从 95 改为动态读取 `core/tool-order.json`（当前 104）。
2. 提取 `core/session-utils.js`、`core/location-utils.js`、`core/avatar-utils.js`、`core/text-utils.js`，消除 `dashboard-services.js` 内重复。
3. 按领域拆分 `core/tools/misc.js` → `world-kb.js` / `watchlist.js` / `system.js`，这是风险最低、收益最高的重构。

**次优先（P1）**：

4. 拆分 `core/tools/recommend.js`，提取 `core/recommend-scoring.js`。
5. 拆分 `core/fetch-x-worlds.js` 为三通道模块，并沉淀 `core/http-fetch.js` 或通过 `api.http.fetch` 暴露给插件。
6. 将 `plugins/official/web-dashboard/index.js` 的剩余路由按领域拆入 `server/routes/*.js`。

**所有拆分必须**：

- 保持 `tools` 数组拼接后顺序与 `core/tool-order.json` 一致；
- 保持 `handler` 函数签名与返回值结构不变；
- 跑通 `node test/test-registry.mjs`；
- 跑通 `node test/test-storage-snapshot.mjs --check`；
- 对新增公共 helper 补充无凭据单元测试；
- 同步更新 `skills/vrc-monitor-agent/SKILL.md` 中工具表分组（若工具文件名变更影响文档描述）。

**本报告基于真实代码统计与分析，所有行号、函数名、文件名均来自仓库当前状态，可直接作为工程师执行拆分的依据。**