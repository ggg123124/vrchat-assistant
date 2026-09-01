# vrchat-assistant — Dashboard 前端重构调研报告

> 调研范围：`ggg123124/vrchat-assistant` 仓库 `plugins/official/web-dashboard` 前端，main 分支，只读分析。
> 统计口径：`find` + `wc -l`，排除 `node_modules/.git/dist`。
> 面向对象：Dashboard 前端开发者。本报告只聚焦前端；后端 `core/dashboard-services.js`、HTTP 路由只在与前端接口契约相关时提及。

---

## 0. 前端整体认知（必读）

Dashboard 前端存在于 `plugins/official/web-dashboard/`，**两套并存**：

| 套 | 目录 | 技术栈 | 状态 |
|----|------|--------|------|
| **新版（主流）** | `web-dashboard/ui/` | Vite + Vue3 `<script setup>` + PrimeVue + 原生 reactive store | 当前主开发线，`index.html` 默认入口 |
| **旧版（legacy）** | `web-dashboard/client/` | Vue2 运行时（`vue.global.prod.js` CDN + jQuery 式组织） | 兼容入口（`?legacy=1`），维护优先级低 |

**本报告聚焦新版 `ui/`**。旧版只在「不建议重构」里顺带说明理由。

**前端与后端接口契约**：新版前端通过 `ui/src/api.js` 的 `get/post/openSse` 统一封装调用，命中的是后端的 `/api/dashboard/*` REST 接口 + SSE `/api/dashboard/stream`。前端文件里共引用约 **80 个** `/api/dashboard/*` 端点。重构前端时**接口路径与返回结构不能变**（行为等价约束落在「前端调用契约不变」上）。

前端 `api.js` 的三个关键约定（重构时不要破坏）：
- token 从 `?token=` 或 `sessionStorage['vrc_dashboard_token']` 取，`apiUrl()` 统一注入；
- `get/post` 用 `AbortSignal.timeout`（默认 25s）做超时，401 → 统一错误文案（会话过期/容器重启自愈）；
- `openSse` 订阅 `/api/dashboard/stream`，收到 `{type:'event', event}` 分发，连接断开自动 `reconnecting`。

---

## 1. 前端源码规模

统计 `web-dashboard/ui/src`（新版前端）源码：

```
src/views/*.vue       25 个视图
src/components/*.vue   7 个组件
src/*.js               6 个运行时文件（main/api/store/utils/toast + composables）
src 总计              ~8,228 行
```

全仓库前端相关（含旧版 client + CSS）约 15,628 行。

新版 `ui/src` 中 `>400` 行的大文件：

| 行数 | 文件 | 类型 |
|------|------|------|
| **1032** | `src/views/FeedView.vue` | 视图（动态事件流主页面） |
| **581** | `src/store.js` | 响应式状态（单一全局 store） |
| **477** | `src/components/WorldDialog.vue` | 对话框组件 |
| **445** | `src/components/UserDialog.vue` | 对话框组件 |
| **444** | `src/components/RightBar.vue` | 组件（桌面右侧栏） |
| **417** | `src/views/TrackedView.vue` | 视图（非好友追踪页） |
| **362** | `src/views/FavoritesView.vue` | 视图（收藏页） |
| 275 | `src/views/FriendsView.vue` | 视图 |
| 261 | `src/views/BoothView.vue` | 视图 |
| 258 | `src/views/PrintsView.vue` | 视图 |

其余视图（Announcements/Avatars/Charts/Events/Logs/Moderation/Notifications/Open/Placeholder/Players/Recommend/Search/Tools/WeeklyReport/Worlds/XWorlds/Groups/Notifications 等）均在 200 行上下，属合理粒度。

---

## 2. 主要大文件分析（只看前端）

### 2.1 `src/store.js`（581 行）— 最高优先

**职责**：全局响应式数据层。对标旧版 `core.js` 模式：**快/慢路径拆分 + 30s 轮询 + SSE + hash 视图同步**。

**问题**：
- **单一巨型 reactive 对象**：`export const store = reactive({...})`，共 **56 个 state 字段**，覆盖 feed（事件流）、friends（好友）、overview（概览）、me（当前用户）、nicknameMap、favFriendIds、watchlistIds、trackedIds、notif、ann 等全部领域，**无任何模块切分**。
- **职责跨域**：一个 store 同时承载 事件流筛选（feedFilter/feedDateFrom/feedOnlyFav/feedOnlyWatch/feedOnlyMe/feedOnlyUser/feedSearch/feedEvents/feedLoading/feedLoadingMore）、好友列表、非好友追踪、通知、头像、图库、收藏、打印、相册……15+ 个不相关领域。
- **高频定时器集中**：`setInterval(() => load(true), 30000)` + `setInterval(refreshMe, 10000)` + `startSse()` + `initFromHash()` 全在 store 里初始化，生命周期管理集中在 init()（574-580 行）。
- **单点阻塞**：行内 `closeMobileDrawers()` 被 5+ 处重复调用，本可提取为公共方法（部分已拆）。
- **兼容性解析函数** `parseEvents(d)`：为兼容 events 接口的「几种历史形状」做了 if/else 嵌套归一化（数组 / 对象含数组 / 对象含对象），这类兼容逻辑建议独立成 util 而非塞在 store 顶层。

**重构方向**：按领域拆为多个 `useXxxStore()` composable（`useFeed`/`useFriends`/`useNotif`/`useTracked`/`useNav`），每个 composable 持有自己的响应式状态与方法，由根 store 组合或直接在组件里组合。这是前端重构价值最高的点。

### 2.2 `src/views/FeedView.vue`（1032 行）— 最高优先

**职责**：动态事件流主页面（feed）。事件列表 + 类型筛选 + 日期范围日历 + 星标/关注/追踪/仅自己筛选 + 行展开详情 + 追踪非好友 + 导出 JSON。

**问题**：
- **单文件组件过大**：1032 行，`<script setup>` + `<template>` 混在一个文件，一个页面包含全部筛选逻辑、列表渲染、详情展开、类型映射。
- **内联常量表**：`typeLabels`（约 24 种事件类型 → 中文名）、`typeIcons`（→ PrimeVue icon）、`typeSeverities`（→ 等级色）、`typeOf`、`statusColor/statusText`、`sourceLabel`、`rowId`、`toggleFilter/toggleFav/toggleWatchFilter/toggleTrackedFilter/toggleMeFilter`、`applyDateRange`、`exportRows`、`trackUser`、`filterByUser`、`filterByWorld`、`canTrack`…… 30+ 个方法全在组件内。
- **重复映射逻辑**：事件类型→展示（标签/图标/等级）的映射在 `typeOf`/`typeLabels`/`typeIcons`/`typeSeverities` 里高度纠缠，且与后端返回的 `type` 字段耦合。
- **筛选状态外溢**：`datePop`/`expanded`/`dateRange`/`trackingId` 等局部 ref 与 store 的 `feed*` 状态边界不清，部分筛选状态放 store、部分放组件本地，切换视图可能丢失。

**重构方向**：
- 把「事件类型 → 展示元数据」的映射抽到 `src/constants/event-types.js`（纯数据，含 label/icon/severity/归一化 `typeOf`）；
- 把复杂的筛选/日期逻辑抽到 `src/composables/useFeedFilters.js`；
- 模板里的事件列表行抽成 `src/components/EventRow.vue`（或 FeedEventCard.vue）；
- 详情展开、导出等独立。

### 2.3 三个对话框组件 `WorldDialog.vue`(477) / `UserDialog.vue`(445) / `RightBar.vue`(444)

**职责**：World/User 详情对话框、桌面右侧好友栏。均是对标 **VRCX 标准**的模态展示（世界信息、用户信息、好友列表）。

**问题**：
- 各 400+ 行，但**主要是模板结构 + 少量方法**。这类「展示型弹窗/侧栏」组件行数多主要是因为 HTML 模板长（信息字段多），**拆分收益中等**——不应强行拆零，但可抽公共子组件（如 `WorldCard`/`UserCard`/`TrustBadge` 已被复用）。
- `RightBar.vue` 承担好友栏布局 + 搜索 + 抽屉/桌双形态，建议抽 `FriendListItem`/`FriendGroupItem`。
- 三个 dialog 里有**重复的用户信息展示块**（头像 / 信任等级 / 状态 / 平台标签），可抽 `UserAvatar`/`TrustBadge`（TrustBadge 已存在）/`StatusBadge` 公共组件。

**重构方向**：中低风险，抽公共子组件 + 抽 `useWorldDetail`/`useUserDetail` composable（拉取 + 处理 `/api/dashboard/world`、`/api/dashboard/user-profile` 数据），组件本身可保持。

### 2.4 `src/store.js` 与 `FeedView.vue` 共同痛点（前端最大的架构债）

- **状态与视图耦合**：store 是唯一响应式源，但 25 个 view 都直接读写这 56 个字段，缺少「按域拆分」→ 任何视图改动都可能影响全局，`store` 成为隐式全局单例，难以单元测试。
- **轮询 + SSE 双通道**：旧 core.js 的「快路径（SSE 增量）+ 慢路径（30s 轮询全量）」模式复制到了新 store，但**视图层感知不到数据源**（是 SSE 来的还是轮询来的），追查 bug 困难。建议引入数据源标记或改用组合式按需订阅（`useSse(type, handler)`）。
- **无测试**：前端无任何单测/组件测试。重构后建议至少为 `api.js`（封装了 token/超时/401 语义）和 `event-types` 映射（纯函数）补 Vitest 单测——这两个是前端行为等价的锚点。

---

## 3. 前端 API 契约（重构不能破坏的边界）

前端通过 `api.js` 调用约 80 个 `/api/dashboard/*` 端点。这些**路径 + 返回结构是前后端契约**，前端重构只能改「如何调用/如何组织/如何渲染」，**不能改调用的路径、参数、返回字段的消费方式**。

关键端点分类（按前端域）：

| 前端域 | 主要接口 |
|--------|----------|
| 事件流 feed | `/events`、`/events-range`、`/friend-events`、`/recent-worlds`、`/co-play`、`/stream`(SSE) |
| 好友 friends | `/friends`、`/nicknames-all`、`/watchlist`、`/watchlist/remove`、`/tracked`、`/tracked/remove`、`/tracked-changes` |
| 概览 overview | `/overview`、`/me`、`/stats`、`/status` |
| 世界 world | `/world`、`/world-instances`、`/world-history`、`/worlds-by-author`、`/world/rate`、`/world/visited`、`/world-note`、`/recent-worlds` |
| 收藏 favorites | `/favorites`、`/favorite-add`、`/favorite-remove`、`/favorites/group`、`/favorites/move` |
| 相册/图库 | `/prints`、`/prints/upload`、`/prints/remove`、`/gallery`、`/gallery/upload`、`/gallery/remove` |
| 通知 notif | `/notifications`、`/notifications/count`、`/notifications/see-all`、`/notification-action`、`/group-announcements`、`/group-announcements-all` |
| 推荐/世界库 | `/recommend-worlds`、`/booth-item`、`/booth-search`、`/booth-searches`、`/x-worlds`、`/x-creators`、`/x-creators/scan` |
| 群组 group | `/group`、`/my-groups`、`/group-announcements` |
| 分析 charts | `/activity-heatmap`、`/game-sessions`、`/weekly-report`、`/ops-log` |
| 其它 | `/search`、`/avatars`、`/avatar/select`、`/image-proxy`、`/player-list`、`/moderation`、`/instance`、`/instance/create`、`/invite-request`、`/worlds-by-author` |

> 注：`/api/1/file/` 前缀是 VRChat CDN 直链（用于头像/图库图片），`/api/dashboard/image-proxy` 是代理。前端处理图片时注意区分。

---

## 4. 前端重构优先级矩阵

排序规则：价值高 = 明显违反单一职责、拆后提升可测试性、可复用；风险低 = 纯组织/切分不改行为。

| 优先级 | 文件 | 价值 | 风险 | 建议动作 |
|--------|------|------|------|----------|
| **P0** | `src/store.js` | 高 | 中 | 按域拆为多个 `useXxxStore()` composable（feed/friends/notif/tracked），根 store 只做组合 |
| **P0** | `src/views/FeedView.vue` | 高 | 中 | 抽 `event-types` 常量、`useFeedFilters` composable、`EventRow` 细分组件 |
| **P1** | `WorldDialog/UserDialog/RightBar.vue` | 中 | 低 | 抽公共 `UserAvatar/StatusBadge/WorldCard` 子组件；抽 `useUserDetail/useWorldDetail` |
| **P1** | `src/api.js` | 中 | 低 | 已是统一封装，保持接口契约，可加轻量化（按域再包一层，如 `api.feed.get()`），但**不改底层 get/post 语义** |
| **P2** | `src/utils.js` / `toast.js` | 中 | 低 | 已较独立，可补充单测 |
| **不做** | `client/`（旧版 legacy） | 低 | 高 | 兼容入口，维护优先级低，重构收益低于风险 |

---

## 5. 分阶段前端重构计划

**总原则：行为等价**。前端「行为」= 调用的 API 路径与参数不变、消费的返回字段不变、界面给出的筛选/展示效果不变。前端无后端那种 MCP 工具数约束，但有两个等价锚点：

- `api.js` 的 `get/post/openSse` 语义（token 注入、25s 超时、401 文案、SSE 分发）不变；
- 每个视图调用的 `/api/dashboard/*` 端点路径与返回字段消费方式不变。

**验证手段**（前端无现成测试，需补）：
- `npm run build`（在 `ui/` 下，Vite 构建通过 = 语法/引用完整）；
- 新增 Vitest 对 `api.js`、`event-types` 映射、`utils.js` 纯函数做单测；
- 手动冒烟：打开 dashboard 各视图，确认动态流筛选、好友栏、世界/用户弹窗、收藏、图库、通知、推荐页均正常。

### Phase 1（低风险，先做）

| 动作 | 目标 | 产出 | 依据 | 验证 |
|------|------|------|------|------|
| 抽取事件类型元数据 | `FeedView.vue` | `src/constants/event-types.js`（`typeLabels/typeIcons/typeSeverities/typeOf`） | 24 种类型的映射纠缠 | 动态流各类型图标/标签不变 |
| 抽取 feed 筛选逻辑 | `FeedView.vue` | `src/composables/useFeedFilters.js`（日期范围、多选类型、星标/关注/追踪/仅自己） | 筛选状态与组件边界不清 | 筛选组合逻辑不变 |
| 抽取事件行组件 | `FeedView.vue` | `src/components/EventRow.vue` | 列表行重复渲染 | 事件列表渲染不变 |
| 抽取公共用户/世界展示 | 三个 dialog | `src/components/UserAvatar.vue`、`StatusBadge.vue`、`WorldCard.vue` | 三处重复展示块 | 弹窗展示不变 |

### Phase 2（按域拆分 store）

| 动作 | 目标 | 产出 | 依据 | 验证 |
|------|------|------|------|------|
| 拆 store 为 composable | `src/store.js` | `useFeed`、`useFriends`、`useNotif`、`useTracked`、`useNav`（各自持 state + 方法），`src/store/index.js` 组合导出 | 56 字段跨 15+ 领域 | 各页数据加载/轮询/SSE 行为不变 |
| 抽出轮询/SSE 生命周期 | `src/store.js` 的 `init` | `src/composables/useRealtime.js`（封装 startSse + setInterval） | 轮询/SSE 全塞在 store  | 动态流快路径（SSE）+ 慢路径（轮询）行为不变 |

### Phase 3（补充测试与边界整理）

| 动作 | 目标 | 产出 | 依据 | 验证 |
|------|------|------|------|------|
| 补前端单测 | `src/api.js`、`src/utils.js`、`event-types` | Vitest 用例 | 前端零测试 | `npx vitest run` 通过 |
| 按域封装 api 调用 | `src/api.js` | 保持底层不变，上层再包 `api.feed.get()` 等 | 80+ 端点调用点分散 | 调用结果与当前一致 |

---

## 6. 不建议重构

| 文件/目录 | 理由 |
|-----------|------|
| `web-dashboard/client/`（旧版 legacy） | 兼容 `?legacy=1` 入口，维护优先级低，大改无收益且可能破坏存量用户/其他 agent 的引用 |
| `web-dashboard/client/dashboard.css`（1936 行） | 旧版样式，随旧版一起处于 low-priority；拆分 CSS 选择器覆盖易乱 |
| `web-dashboard/ui/src/style.css`（382 行） | 新版全局样式，属合理粒度（全局 token/重置），拆分收益低 |
| 各视图 `<view>.vue`（200 行上下，25 个） | 按页拆分已是合理粒度；再拆=过度设计 |
| `GroupDialog/InstanceDialog/QuickSearch/TrustBadge` 等小组件 | 已是原子化组件，保持 |

> 注意 `web-dashboard/ui/src/views/` 下已有 `PlaceholderView.vue`——若某视图是占位（未实装），重构时无需为它投入，先聚焦已实装的高频页（feed/friends/world/user/收藏）。

---

## 7. 与项目既有架构一致性

- **前端无「核心层/插件层」分离约束**——前端只属于 web-dashboard 插件，重构可在 `ui/src` 内自由组织（views/components/composables/constants 已符合 Vue3 约定）。
- 现有 `ui/src` 已初步分层：`views/`（路由页）+ `components/`（原子件）+ `composables/`（复用逻辑，现有 `useFriendGroups.js`）+ `api.js`（请求层）+ `store.js`（状态层）。**重构方向是延续并强化这一分层**，不是另起一套。
- **不要碰后端**：`core/dashboard-services.js`、`plugins/official/web-dashboard/server/`、`index.js`（HTTP 路由）不属于前端，除非接口契约需要配合调整（本报告以「保持契约」为默认，不主动建议改后端）。
- **前端的「行为等价」约束**：接口路径、返回字段消费、SSE 事件分发、token/超时/401 语义不变。前端没有 MCP 工具数那种硬校验，等价锚点在 `npm run build` 通过 + 手动冒烟 + 新增 Vitest 对纯函数层做单测。

---

## 8. 执行清单（给前端开发者的落地顺序）

1. **Phase 1**：抽 `event-types` 常量 + `useFeedFilters` composable + `EventRow` / `UserAvatar` / `StatusBadge` / `WorldCard` 子组件（低风险、不动 store）。
2. **Phase 2**：按域把 `store.js` 拆成 `useFeed/useFriends/useNotif/useTracked` 组合式（**拆一个域验证一个域**，先拆 feed 因为最复杂且最常被改）。
3. **Phase 3**：补 Vitest（`api.js`/`utils.js`/纯函数），再按域封装 api 调用层。
4. **全程守住**：`npm run build` 通过 + 冒烟关键页 + 接口契约不变 + `?legacy=1` 旧入口保持可用。

所有建议基于对 `ui/src` 现有代码（`store.js` 56 字段、`FeedView.vue` 1032 行模板/方法、三个 400+ 行 dialog、`api.js` 80 个端点消费契约）的实际分析，可直接执行。
