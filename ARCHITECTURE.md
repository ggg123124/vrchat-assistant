# 系统架构

> 本文档面向需要理解系统内部结构的 AI Agent。部署配置见 [AGENTS.md](./AGENTS.md)，开发约束见 [DEVELOPMENT.md](./DEVELOPMENT.md)，插件开发见 [docs/PLUGIN-DEV.md](./docs/PLUGIN-DEV.md)，插件契约见 [docs/PLUGIN-API.md](./docs/PLUGIN-API.md)。

> **当前架构（PR-2 插件化重构后）**：功能以「核心域工具 + 插件域工具」分层存在，统一由注册表（`core/registry.js`）按 `core/tool-order.json` 的**顺序混合索引**输出。插件通过 `core/plugin-loader.js` 加载、按 `core/plugin-api.js` 的 6 面 API 与核心交互，**不触碰全局 `ctx`**。旧的三件套（`mcp-definitions.js` / `rpc-router.js` / `core/handlers/*`）已被替换——本文档以此现状为准。

## 数据流总览

```
VRChat WebSocket (wss://pipeline.vrchat.cloud)
        │
        ▼
  ws-manager.js ─── 认证/token 刷新/心跳/重连
        │
        ▼
  event-pipeline.js ─── 事件标准化 + 世界名解析
        │
        ▼
  storage.js (SQLite, WAL 模式)
        │
        ├── events 表（事件流：上下线/位置/Avatar/状态/Bio 变更）
        ├── friends 表（好友当前状态快照）
        ├── world_cache 表（世界名+元数据缓存）
        ├── nicknames 表（本地昵称映射）
        ├── watchlist 表（关注名单）
        ├── config 表（本地配置键值对：推荐偏好/分组权重等）
        ├── world_kb 表（本地世界知识库：新世界追踪 + 用户状态 rating/visited/backlog）
        ├── join_choices 表（推荐选择学习）
        ├── group_cache 表（群组信息缓存）
        ├── world_history 表（世界信息变更记录）
        ├── world_zh_translations 表（中文简介翻译缓存）
        ├── planet_cache 表（PlanetVRC 世界信息缓存）
        ├── booth_items 表（BOOTH 商品快照缓存）
        ├── booth_search_history 表（BOOTH 搜索历史）
        └── plg_<插件名>_* 表（插件私有表，与核心表隔离）
        │
        ▼
  core/registry.js（listTools / dispatch，按 tool-order.json 混合索引核心+插件工具）
        │
        ▼
  MCP tools/list & tools/call (HTTP SSE, :8799/mcp)
        │
        ▼
  Hermes Agent / 任意 MCP 客户端
```

## 插件化架构层次

PR-2 起，系统分为四层：**底座层 → 服务层 → 插件层 → 工具层**。功能不再硬编码进核心，而是以插件形式存在；核心只保留认证/采集/存储/传输底座。

### 1. 注册表层（core/registry.js）

中央工具注册表的唯一入口。

- 启动时按 `core/tool-order.json`（`tool_order` 数组）遍历：每个工具名优先到 `coreRegistry`（核心自声明工具）取、否则到 `pluginToolMap`（插件工具）取——**核心+插件混合索引，输出顺序与 tool-order 一致**；
- `listTools()` 产出 MCP `tools/list`（先核心、再插件，顺序稳定），经 `safe-mode.js` 过滤后返回；
- `dispatch(name, args)` 分发 `tools/call`：插件工具优先，其次核心工具；对任何工具都会走 `safeMode.assertToolAllowed`（安全模式过滤对插件工具**同样生效**，插件不绕过）；
- 提供 `registerTool`（核心自声明工具）、`registerPluginTool(def, origin)`（插件注册，冲突即抛错）、`removePluginTools(origin)`（热重载时注销某插件全部工具）、`hasTool`。

### 2. 插件加载器层（core/plugin-loader.js）

`PluginLoader` 类负责插件的完整生命周期。

- **扫描**：从 `plugins/official/`、`plugins/local/`、`$VRC_MONITOR_PLUGINS_DIR` 收集插件（目录形态 `plugin.json + index.js (+ schema.sql)`，或单文件 `.js`）；
- **校验**：读取并校验清单（`plugin.json`），做**静态扫描**（禁止 import 核心路径 / 敏感 env / 敏感文件 / `child_process` / `process.exit`）；
- **依赖排序**：按 `depends` 做拓扑排序（被依赖者先加载；依赖缺失 → 拒绝加载并指引；依赖环 → 拒绝加载并报环）；
- **加载**：执行可选 `schema.sql`（裸表名自动重写为 `plg_<name>_` 前缀）→ `import()` 插件入口（带时间戳防 ESM 缓存）→ 调用默认导出的 `register(api)`；
- **失败隔离**：任一插件加载失败只禁用该插件、记录 error，不影响服务主链路或其他插件；
- **热加载**：watch 插件目录，新增/修改/删除即生效；变更时先调旧版 `dispose()`、注销其工具，新版失败则回滚旧版并告警；热加载后既有 WS 连接与进行中的调用不中断。

### 3. 插件 API 层（core/plugin-api.js）

`buildPluginApi(pluginName, deps)` 构造**插件唯一合法的交互面**，共 6 面（契约 v1.1）：

- `api.registerTool(def)` — 注册 MCP 工具（工具对外暴露的唯一入口）；
- `api.db` — 命名空间存储，显式表句柄，强制 `plg_<name>_` 前缀，插件间不可跨表；
- `api.vrchat.fetch(path, options?)`（含上传/下载辅助）— 调用 VRChat REST，自动带核心登录态与限流；
- `api.log(message)` — 统一日志（带插件名前缀与时间戳）；
- `api.tools.call(name, args)` / `api.tools.has(name)` — 调用/探测核心或其他插件的 MCP 工具；
- `api.provide(name, fn)` / `api.consume(name, ...args)` / `api.hasService(name)` — 插件间轻量服务注册与消费。

插件代码只能通过这些 API 与核心交互，**禁止 import 核心内部模块、触碰全局 `ctx`、直连数据库文件**。

### 4. 核心服务化层（start-monitor.js `registerCoreServices`）

为了让插件在不触碰 `ctx` 的情况下复用核心能力，核心把一批功能以**命名服务**注册到 loader 的共享服务注册表（`loader.services` / `serviceOwners`，owner 标为 `core`），插件用 `api.consume("<域>.<名>", args)` 消费：

- **`storage.<method>`**：核心存储方法白名单（如 `getWorldName` / `upsertWorld` / `getBoothItemCache` / `listBoothItems` / `getZhTranslations` / `setWorldFavorited` 等）；
- **`x.<name>`**：X 博主世界推荐（`creators` / `addCreator` / `removeCreator` / `worlds` / `scanCreators` / `worldDigest`）；
- **`world.<name>`**：世界知识库（`scanNewWorlds` / `getNewWorlds` / `rateWorld` / `markWorldVisited` / `addToBacklog` / `getBacklog` / `removeFromBacklog` / `searchWorlds`）；
- **`recommend.<name>`**：推荐引擎（`favoriteFriendsLocations` / `setJoinPreference` / `getJoinPreference` / `recordJoinChoice` / `recommendJoin` / `recommendWorlds` 等）。

这样插件工具只做「定义工具 + 把参数转交核心服务」，自身不持有业务逻辑与运行时上下文。

### 5. 工具分层

| 层次 | 位置 | 形态 | 职责 |
|------|------|------|------|
| 核心域工具 | `core/tools/*.js`（auth / events / friends / instance / misc / notifications / recommend / recommend-worlds / social-write） | 每个文件默认导出 `tools` 数组（自声明 def），启动时经 `core/registry.js` 注册 | 认证、事件、好友、实例、杂项、通知、推荐等基础与核心能力 |
| 插件域工具 | `plugins/official/*/index.js`（booth / favorites / groups / media / planet / recommend / world-kb / x-creators） | 每个插件默认导出 `register(api)`，经 `registerTool` 注册 | 按领域扩展的功能，复用核心服务 |

两层工具统一进入同一注册表与命名空间（工具名全局唯一），对 MCP 客户端**无差别**。

## core/ 模块职责

| 模块 | 职责 | 关键导出 |
|------|------|----------|
| `storage.js` | SQLite 封装层。所有数据库读写通过此模块。WAL 模式即时落盘。含迁移逻辑（ALTER TABLE ADD COLUMN 幂等）、同屏/见面分析、推荐评分查询。插件私有表由 `api.db` 写入，与核心表隔离 | `Storage` 类 |
| `registry.js` | 工具注册表。按 `tool-order.json` 混合索引核心+插件工具，产出 `listTools` / `dispatch` / 安全模式过滤 | `listTools` / `dispatch` / `registerTool` / `registerPluginTool` / `removePluginTools` / `hasTool` |
| `plugin-loader.js` | 插件加载器。扫描/校验/依赖拓扑排序/执行 schema/热加载/失败隔离 | `PluginLoader` 类 |
| `plugin-api.js` | 插件 API 面。构造插件唯一合法的交互对象（6 面） | `buildPluginApi` |
| `safe-mode.js` | 安全模式子系统。`VRC_MONITOR_SAFE_MODE=true` 时从 `tools/list` 剔除并拦截 `tools/call` 破坏性工具（删除/移除/退出/清除类），防御误删 | `DESTRUCTIVE_TOOLS` / `isSafeModeEnabled` / `filterTools` / `assertToolAllowed` |
| `tool-order.json` | 工具顺序清单 `tool_order`（所有工具名的有序数组，核心+插件统一） | — |
| `ws-manager.js` | WebSocket 连接生命周期。指数退避重连（1s→60s）、心跳保活（30s ping）、认证冷却、直连优先+代理回退、TOTP/2FA 重连处理 | `WsManager` 类 |
| `event-pipeline.js` | WebSocket 事件标准化与持久化。按事件类型分发处理，更新 friends 表 + 写入 events 表 | `EventPipeline` 类 |
| `friend-state.js` | 好友在线状态内存缓存。O(1) 查询在线好友，重连后批量刷新 | `FriendStateManager` 类 |
| `rate-limiter.js` | VRChat API 请求限流器。默认 2.6s 间隔，队列+并发控制 | `RateLimiter` 类 |
| `vrchat-launch.js` | 打开实例统一入口。Windows 命名管道直发 → 探测失败静默回退 API 自我邀请。平台门控 + 超时保护 | `openInstance()`（默认导出，含 `launchViaPipe` / `inviteSelfViaApi` / `buildLaunchUrl` / `isPipeSupported` / `LAUNCH_PIPE`） |
| `new-worlds.js` | 新世界扫描核心逻辑。垃圾过滤、热度评分、分类、翻页拉取（供 `world.*` 服务复用） | `isJunkWorld` / `worldScore` / `classifyWorlds` / `fetchFreshWorlds` |
| `recommend-worlds.js` | 多源融合世界推荐核心逻辑。作者画像、候选收集、评分、可解释 reasons（供 `recommend.*` 服务复用） | `recommendWorlds` / `collectCandidates` / `scoreCandidate` / `buildAuthorProfile` |
| `fetch-x-worlds.js` | X 博主世界推荐抓取。RSS 抓取、推文解析、收藏/浏览统计入库、博主清单管理（供 `x.*` 服务复用） | `fetchCreatorRss` / `scanCreatorWorlds` / `getWorldDigest` / `addCreator` / `removeCreator` |
| `world-names.js` | 世界名批量解析（缓存→API→写回→负缓存） | `resolveWorldNames` / `resolveWorldName` |
| `theme-config.js` | 主题关键词配置（sleep/chat/onsen/game/default 等）+ 正则编译 | `DEFAULT_THEME_CONFIG` / `getThemeRegex` |
| `backup.js` | 数据库在线备份。beter-sqlite3 `db.backup()` API，WAL 模式无需停机。保留最近 2 份 | `backupDatabase()` 函数 |
| `server-context.js` | 共享上下文。可变 `ctx` 对象持有核心运行状态（storage/api/rateLimiter/wsManager 等）。**核心工具使用；插件不触碰，走 `api.*`** | `ctx` / `log` / `parseLocation` / watchlist 缓存管理 |
| `http-server.js` | HTTP 服务器 + SSE 端点。McpSession 管理、`/health` + `/mcp` 请求路由 | `createServer` / `sendSSE` / `sendError` |
| `otp-fetcher.js` | OTP 邮箱抓取。调用 `fetch-otp.py` 从邮箱 IMAP 抓验证码 | `fetchOtpFromEmail` |
| `totp.js` | RFC 6238 TOTP 生成（纯 Node crypto 零依赖） | `parseTotpSecret` / `generateTotp` / `getTotpCodes` |
| `notifier.js` | 登录状态通知中心。needsTotp/otpFailed/reauthFailed/recovered 事件通知、去抖聚合、通道可插拔注册 | `notifier` 实例 |
| `notify-channels.js` | 跨平台通知通道：desktop（notify-send/osascript/PowerShell toast）+ webhook（POST JSON） | `buildChannels` |
| `vrcx-db-paths.js` | VRCX 数据库路径自动探测（Windows/Linux/macOS，含 Wine） | `findVrcxDb` / `candidateVrcxDbPaths` |
| `init-db.sql` | 数据库 DDL（建表语句）。幂等写法（IF NOT EXISTS），`storage.js` 初始化时执行 | — |
| `init-x-worlds.sql` | X 博主世界推荐相关表 DDL（幂等） | — |

## start-monitor.js 内部分区

`start-monitor.js` 是薄入口（约 360 行），保留启动流程与核心服务注册：「加载凭据 → 认证/OTP/TOTP → WebSocket → 定时备份 → HTTP 监听」；并调用 `registerCoreServices(loader, ctx)` 把 `storage.*` / `x.*` / `world.*` / `recommend.*` 服务注册进插件加载器的共享服务表，供插件 `consume`（见「核心服务化层」）。

| 区域 | 职责 |
|------|------|
| import + .env + 路径常量 | 模块 import、`.env` 解析（只取 `VRC_MONITOR_*`）、路径常量 → `ctx.paths`、端口/备份间隔常量 |
| 核心服务注册 | `registerCoreServices(loader, ctx)`：向 `loader.services` 暴露核心服务（owner = `core`） |
| WS 事件处理 | `_updateFriendState` / `_refreshOnlineState`（使用 `ctx.friendState` / `ctx.api`） |
| 端口占用探测 | `net.connect` 探测 8799，已占用则提示排查并退出（防双实例互抢 OTP） |
| 启动主流程 | `main()`：初始化 DB → API 认证（OTP/TOTP 自动链）→ WS → 定时备份 → HTTP 监听 |
| 优雅关闭 | SIGINT/SIGTERM 处理（关闭 WS、收尾 SQLite 事务） |
| 全局异常兜底 | uncaughtException/unhandledRejection 兜底 |

## 依赖关系图

```
start-monitor.js
  ├── core/server-context.js  (ctx, log, parseLocation, watchlist cache)
  ├── core/registry.js        (listTools / dispatch / registerPluginTool / removePluginTools)
  │     └── core/tools/*      (9 个文件：auth/events/friends/instance/misc/notifications/
  │                            recommend/recommend-worlds/social-write，自声明 tools 数组)
  ├── core/safe-mode.js       (filterTools / assertToolAllowed / isSafeModeEnabled / DESTRUCTIVE_TOOLS)
  ├── core/http-server.js     (createServer, SSE 辅助；/health + /mcp 路由)
  ├── core/plugin-loader.js   (PluginLoader：扫描/校验/拓扑排序/热加载)
  │     └── core/plugin-api.js(buildPluginApi → 6 面 API)
  │           └── plugins/official/*（booth/favorites/groups/media/planet/recommend/
  │                                   world-kb/x-creators，register(api)）
  ├── core/otp-fetcher.js + core/totp.js         （认证）
  ├── core/notifier.js + core/notify-channels.js （登录状态主动通知）
  ├── core/init-db.sql / core/init-x-worlds.sql  （DDL）
  └── (核心底座：storage, ws-manager, event-pipeline, friend-state, rate-limiter,
       vrchat-launch, new-worlds, recommend-worlds, fetch-x-worlds, world-names,
       backup, theme-config 等)
```

> 插件一律通过 `plugins/official/` / `plugins/local/`（或 `$VRC_MONITOR_PLUGINS_DIR`）加载，经 `api.*` 与核心交互；旧的三件套（`mcp-definitions.js` + `core/handlers/*` + `rpc-router.js`）已由「注册表 + `core/tools/*` + 插件」替代。

## 数据库 Schema 概览

| 表 | 用途 | 关键字段 |
|----|------|----------|
| `events` | WebSocket 事件流 + 迁移历史 | type, user_id, content_json, world_id, created_at, source |
| `friends` | 好友当前状态快照 | user_id(PK), display_name, is_online, location, last_seen |
| `world_cache` | 世界名+元数据缓存（懒刷新） | world_id(PK), name, note, author_name, tags, favorited |
| `nicknames` | 本地昵称映射 | user_id(PK), nickname, display_name |
| `watchlist` | 关注名单 | user_id(PK), priority |
| `config` | 本地配置键值对（推荐偏好/分组权重等） | key(PK), value |
| `world_kb` | 本地世界知识库（新世界追踪 + 用户状态） | world_id(PK), favorites, visited, tags, user_rating, backlog |
| `join_choices` | 推荐选择学习数据 | user_id, world_id, recommend_score, rank_in_list |
| `group_cache` | 群组信息缓存 | group_id(PK), name, member_count |
| `world_history` | 世界信息变更记录 | world_id, field, old_value, new_value |
| `world_zh_translations` | 中文简介翻译缓存 | world_id(PK), zh, updated_at |
| `planet_cache` | PlanetVRC 世界信息缓存 | key(PK), payload(JSON), fetched_at |
| `booth_items` | BOOTH 商品快照缓存 | id(PK), name, price, wishlist_count, ... |
| `booth_search_history` | BOOTH 搜索历史 | id, query, result_ids(JSON), ... |
| `plg_<插件名>_*` | 插件私有表（经 `api.db`，与核心表隔离） | 由插件 schema 定义 |

## 外部依赖

| 依赖 | 用途 | 备注 |
|------|------|------|
| `better-sqlite3` | SQLite 原生绑定 | WAL 模式，崩溃安全，支持并发读 |
| `ws` | WebSocket 客户端 | 连接 VRChat pipeline |
| `https-proxy-agent` | HTTPS 代理 | WS 直连失败后回退代理 |
| `fetch-otp.py` | 邮箱 IMAP OTP 抓取 | Python 脚本，由 Node `execFileSync` 调用 |

## 外部集成

| 集成 | 位置 | 说明 |
|------|------|------|
| Hermes 插件 | `hermes-plugin/` | 进程托管：on_session_start 自动拉起、崩溃自愈、vrc_status 等管理工具。仅 Windows |
| 桌面插件 | `desktop/plugin.js` | GUI 配置入口：填写凭据、查看状态 |
| Dashboard 后端 | `hermes-plugin/dashboard/` | `/status` `/credentials` `/doctor` 等 API 路由 |
| Agent Skill | `skills/` | 开箱即用的 skill 文档（含 MCP 工具总纲、各能力域工作流、开发/审核规范） |
| 官方插件 | `plugins/official/` | 8 个官方插件（booth / favorites / groups / media / planet / recommend / world-kb / x-creators），插件契约与开发的参考实现 |
