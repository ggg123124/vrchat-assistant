# PR 提交材料（psenY/vrchat-assistant → ggg123124/vrchat-assistant）

> 生成日期：2026-08-30
> 数据：fork 领先上游 335 提交、0 落后（零冲突）；上游活跃（最近提交 2026-08-28）

## 建议 PR 标题

`feat(dashboard): Web Dashboard 完整实装——24 视图 + 非好友追踪 + 媒体管理 + 素材/公告 + 性能预热（335 提交）`

## PR 摘要

本 PR 将 fork（psenY/vrchat-assistant）中对 Web Dashboard 的完整开发合入上游：
在既有插件化架构（plugins/official/web-dashboard + core/dashboard-services.js）基础上，
将 Dashboard 从「占位页」推进为**可日常使用的完整控制台**：24 个视图全部实装、
非好友追踪闭环、VRChat Plus 媒体管理（增删查上传）、BOOTH 素材检索、群组公告历史、
社区活动聚合、世界推荐、多源图表/周报、通知中心（徽标/只看未读/一键已读）等。

## 主要特性（按模块）

### 核心数据服务（core/dashboard-services.js，owner=core）
- `dashboard.*` 服务族下沉：tracked（非好友追踪）/ trackedChanges / weeklyReport / recommendWorlds / communityEvents / groupAnnouncements / worldHistory / recentWorlds / stats 等
- 迁移：tracked_non_friends 表（status/status_description/location/removed_at 列，幂等 PRAGMA 模式）
- 性能：慢路由启动预热（community-events 48s→4ms、recommend-worlds 11s→2ms）+ 缓存 TTL 分级

### 非好友追踪（用户需求闭环）
- 追踪列表/添加（搜索 + 直接粘贴 ID）/移除（removed_at 持久化，刷新循环过滤已移除）
- 每小时资料快照 diff → 变化时间线（头像/简介/状态/位置）；在线状态点 + 徽章
- 三入口联动：动态页「追踪此人」→ 资料弹窗「追踪」→ 追踪页管理；动态页「只看追踪」

### 24 个视图全部实装
动态/好友/非好友追踪/收藏/日志/玩家/通知/模型/足迹/媒体(相册+画廊)/素材(BOOTH)/公告/
X推荐/推荐/群组/活动/图表/周报/屏蔽/工具/搜索/直接打开 + 桌面侧栏/移动抽屉分组导航

### 媒体管理（VRChat Plus）
- 相册/画廊：网格 + 世界筛选 + 预览（键盘导航/打开原图/上一张下一张）+ 上传（base64 管线）+ 删除（安全模式拦截）

### 素材检索（BOOTH）
- 搜索（日/英）+ 详情（收藏数=热度/标签/店铺）+ 标签/店铺点击搜索 + 本地收藏（星标/筛选/导出）+ 最近搜索

### 群组/社区
- 群组页（公告预览/链接复制）+ 公告历史页（跨群组时间线/日期分组/新公告徽标/复制全文）
- 社区活动聚合（群组挖掘 + 日历源，缓存 30 分钟）

### 通知中心
- 当前/历史 + 类型筛选 + 只看未读 + 一键已读 + 未读行高亮 + 导航徽标（SSE 实时 +1 / 查看归零 / 重连校准）

### UI 统一（设计系统收敛）
- 全局基元：chip/empty/loading-mini/star/h2/input/统计卡/mono/浮层圆角 → 单点定义（各视图去重）
- 视觉：视图切换淡入、卡片悬停微浮起、空态图标、类型图标体系（动态/通知/日志）、回到顶部、搜索框焦点态
- 可访问性：prefers-reduced-motion、焦点环、语义 aria-label

### 运维与安全
- scripts/backup-prod.sh（MCP 在线备份 + 归档轮换 10 份 + SQLite magic-header 自验证）
- scripts/deploy.sh / verify-container.sh（20 路由全检）；安全模式拦截破坏性操作（删除/移除）
- 测试：npm test 37 全绿（dashboard 服务/工具/解析回归）

## 变更面

- 89 文件、+24,557 / -140（plugins/official/web-dashboard 全套 + core 服务 + start-monitor + scripts + docs）
- 全部提交 SSH 签名 Verified；CI（GitHub Actions）全绿

## 验证记录

- 生产容器（路由器 iStoreOS docker）22 项验证全通过；health auth/ws/sse 全绿
- npm test 37 PASS；doc-drift has_drift=false
- 备份可恢复性抽查：integrity ok / 4020 事件

## 备注

- PR 提交数较大（335）：若上游希望分批，可拆为「核心服务 + 追踪」「视图全家桶」「媒体/素材」「UI 统一」四组，需上游反馈
- fork 的 docs/DASHBOARD-DEV-STATUS.md 有每轮开发的完整记录，可作评审参考
