# 上游同步后：Dashboard 性能审计（上游快 ≠ Dashboard 快）

> 触发：同步上游 PR 后用户反馈“上游说拉取收藏世界很快了，我测试还是要非常久”。
> 与 `fork-sync-workflow.md` 互补（那边讲同步流程，本篇讲同步后如何核实 Dashboard 真的吃到优化）。

## 排查法：分三层测耗时，定位慢点

1. **原始 VRChat API 层**：容器内带 cookie+UA 直打上游用的端点（如 `/worlds/favorites?n=100`）。本会话实测 1.2s —— 证明上游优化本身生效。
2. **Dashboard 接口缓存命中**：`/api/dashboard/favorites?type=worlds`（TTL 内）。本会话实测 78ms。
3. **Dashboard 接口冷拉**（部署后/缓存清空）。本会话实测 3.1s（110 个收藏世界，TTL 30min）。

结论：接口本身已是“冷拉 3s / 缓存 78ms”，远非用户感受的“非常久” → 慢点不在 API。

## 关键陷阱：上游优化的是工具，Dashboard 可能还在调多余的第二个请求

- 上游把 `get_my_favorite_worlds` 改成 `/worlds/favorites` 一次拉全（返回含 `favoriteGroup`/`worldName`/`imageUrl` 的平铺对象）。
- 但 Dashboard 插件自己的 `loadFavoriteWorlds` 仍**额外串行调 `/favorites?type=world&n=100`** 拿收藏夹分组 —— 上游返回已含 `favoriteGroup`，第二个请求**纯冗余**（多占一次限流、串行排队拖慢冷拉）。
- 修复：删掉第二个请求，直接用上游返回的 `favoriteGroup`。改前先确认上游工具返回的字段名（读工具 handler 的返回对象，别猜）。

## 剩余“久”的两种可能（问用户，别猜）

- **前端渲染**：大量世界卡片 + 封面大图加载慢（接口 78ms 但页面要拉几十张图）。
- **浏览器缓存旧版**：没 Ctrl+F5，还在跑部署前的旧逻辑。
- 请用户强刷后复测，并区分“等接口”还是“图片转圈”。

## 通用启示

- 上游优化/性能声明后，**先量三层耗时再下结论**，别把“上游说快”当“Dashboard 快”。
- 任何时候觉得慢，第一反应是**分别测**（原始 API / 缓存命中 / 冷拉 / 前端渲染），定位到层再动手。
