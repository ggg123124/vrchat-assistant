# VRChat /favorites 与私有 Avatar 的 API 坑（2026-08 实测）

> 补充 `vrcx-data-parsing-and-api-gotchas.md`（本轮无法直接 patch 该文件，另立此篇，后续可合并）。

## /favorites 参数与返回结构

- `/favorites?type=` 的合法值是**单数**：`type=friend`。`type=friends` 会 **400**——踩过 `friends` 400 后修正为 `friend` 才通。
- `/favorites?type=world` 返回的 favorite 对象结构特殊（这版 API）：
  - `favoriteId` = worldId（真正的世界 ID）
  - `id` = 收藏记录 id（`fvrt_xxx`）
  - **收藏夹名在 `tags`**（如 `["worlds2"]`）
  - **没有 `favoriteGroupId` 字段**（对默认收藏夹为 null）
  - 按收藏夹分组时用 `favoriteId` + `tags[0]` 映射。实测：worlds1=90 / worlds2=4 / worlds3=1 / worlds4=5 / 未分组=10。

## 私有 Avatar

- `/avatars?userId=<真实id>&n=&sort=updated` 默认只返回 **public** 模型。
- 要显示私有模型加 `releaseStatus=all`：`/avatars?userId=<id>&n=40&sort=updated&releaseStatus=all`。
  - 该参数**个别账号会 400**，实现要 try 带参 → 失败回退无参。
- 私有模型很常见：用户"当前使用"的模型往往是 private，仅靠 `?userId=` 会显示为空，需从 `/auth/user` 的 `currentAvatar/currentAvatarName/currentAvatarImageUrl` 单独带出"当前使用"。
- 收藏 Avatar 用专门端点 `/avatars/favorites?n=`（不要用 `/favorites?type=avatar`）。

## 仅网页端在线（platform=web）

- friends DTO 的 `platform`：游戏内为 `standalonewindows`/`android`/`quest` 等，**仅网页端在线为 `web`**（`is_online` 仍为 1）。
- 前端区分：`isWebOnline(x) = x.isOnline && String(x.platform).toLowerCase().includes('web')`，显示"仅网页在线"（灰色状态点、无游戏位置/实例），与游戏内在线（绿/蓝/黄/红状态灯 + 世界位置）分开。注意大小写（`Web`）与离线排除（`isOnline=0` 不算）。
