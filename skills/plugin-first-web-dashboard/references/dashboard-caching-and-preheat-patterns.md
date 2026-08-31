# Dashboard 慢接口提速：缓存 / 预热 / 前端视图缓存 / stale-while-revalidate

> 2026-08-26 会话实战验证。目标：消灭"页面首次打开慢"和"视图切换竞态跳页"。

## 慢接口首次打开慢的根因

VRChat 限流 API **串行排队**（每请求 ~2.6s）。冷缓存时实测：
- 我的模型 `/avatars`：`/auth/user` → `/avatars`（串行 2）+ `/avatars/favorites`（并行）≈ 5.6s
- 屏蔽管理：`blocked` + `muted` 并行 ≈ 5s
- 收藏世界：`get_my_favorite_worlds` 逐个查世界详情 ≈ 7s+
- 通知 ≈ 2.6s

## 机制组合（按叠加顺序，缺一不可）

### 1. 缓存 TTL 按"数据变化频率"定
收藏世界 / 我的模型 / 屏蔽管理 **30min**，收藏好友 10min，首页收藏位置 5min。
- 修订记录：我的模型/屏蔽从 10min 提到 30min——模型列表、屏蔽列表用户很少变。
- 命中缓存实测：`moderation` 2943ms → 5ms；`avatars` 5638ms → 13ms。

### 2. 后端错峰预热（插件 register 内）
- 注册后 30s 首次、每 10min 一轮，**逐项间隔 15s** 逐个拉取填缓存（避免同时占满限流队列拖慢 WS 主流程）。
- 预热顺序按用户关注度：**avatars → moderation → favoriteFriends**。
- **只预热 2~3 个限流请求的轻接口**；`get_my_favorite_worlds`（~60 世界 × 限流 ≈ 150s）太重，不预热，靠 30min TTL 兜底。
- disposer 必须 `clearInterval(preheatTimer)` + **`clearTimeout(preheatTimeout)`**——漏清 `setTimeout` 会让进程/冒烟脚本挂住不退出。timer 加 `unref()` 防阻塞退出。

### 3. 前端 get() 白名单缓存（app.js）
- 只对**慢视图接口**（home/favorites/avatars/moderation/notifications/recent-worlds/stats）做 ~60s 前端缓存——切走再切回**秒显旧数据** + 后台 `refreshViewGet()`。
- **轮询接口（overview/friends/events）绝不缓存**——保持实时（30s 轮询靠它们）。
- 写操作（标记已读 / 接受 / 拒绝通知）成功后调 `invalidateViewCache(prefix)`，防显示旧数据。

### 4. stale-while-revalidate（后端路由级）
缓存过期但有旧数据时：先 `sendJson(stale)` 秒回 + 后台 `loadPayload().then(setCached)` 刷新。任何场景不白等。用于 avatars 路由——**抽公共 `loadAvatarsPayload(api, limit)`** 供路由同步拉取与后台刷新共用，避免重复代码。

### 5. meCache（/auth/user 5 分钟）
avatars 冷缓存时把"串行 2 限流"降为"串行 1 限流"：`/auth/user`（uid + 当前模型）短时间不变，模块级缓存 `{at, data}`，命中直接复用。

## 验证与陷阱

- **预热窗口**（部署后 ~30-45s）内用户并发请求会排限流队列（实测 `avatars` 首次 ~29s）；stale-while-revalidate 兜底后秒回旧数据。
- **部署后真正第一次**（后端无任何缓存）仍要冷拉（avatars ~5.6s）——这是数据极限，之后 30min 内命中 ~13ms。
- **注册冒烟判重必须用 `${method} ${path}`**：`/api/dashboard/nickname` 有 GET（查询）+ POST（设置）两个合法路由，按 path 单独判重是误报。
- 改完性能机制容器内实测：**连续两次**调慢接口，首次冷拉耗时 vs 第二次命中耗时（如 2943ms→5ms）作为提速证据。
- 前端竞态防护（viewToken）见 `frontend-modularization-without-build-tools.md`。
