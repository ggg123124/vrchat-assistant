# VRChat 数据解析完整性与 API 参数坑

> 本会话在把 Dashboard 对齐 VRCX Feed/资料页时实际踩过的坑与验证过的做法。
> 上游参考：VRCX `src/views/Feed/columns.jsx`（列定义与 detail 渲染）、`confusables.js`（同形字检测）。

## 事件解析不完整的排查流程（用户报“和 VRCX 对不上 / 信息不全”时）

1. 读参考应用的列/类型定义：VRCX Feed 类型 = GPS/Online/Offline/Status/Avatar/Bio；`detail` 列按类型渲染（位置含旧→新、状态图标变化、头像图+名、bio 文本）；展开行显示 `previousLocation ↓ location` + 世界名/群组名。
2. 查实际存储的 `content_json` 结构（**不猜**，见下节探针）。
3. 对照 DTO：事件服务若只返回 `summary`，要把 content 里的 detail 字段补进 DTO 并让前端按类型渲染。

本项目 WS 推送把 **VRChat 原始 content** 存入 `events.content_json`，结构：
- `friend-location`: `{userId, platform, location, travelingToLocation, worldId, canRequestInvite, user:{…}, world:{id,name,description,…}}`
- `friend-active`: `{userId, user:{status, statusDescription,…}}`
- `friend-add`: `{userId, user:{displayName,…}}`
- `user-location`: `{userId, location, instance, user:{…}}`
- `friend-update`: **两种并存** —— 原始 `{userId, user}`（每次推送都存）+ 管道 diff 构造 `{userId, displayName, type, …payload}`（仅变化时插入，`type=avatar/bio/status/user_icon/pronouns`，payload 含新旧值）。DTO 解析必须双保险（`content.xxx || content.user.xxx`）。

补 DTO 时的完整字段清单：`status/statusDescription/previousStatus/previousStatusDescription/avatarName/avatarImageUrl/previousAvatarImageUrl/bio/previousBio/userIcon/pronouns/instanceType/region/instanceId/previousLocation/previousWorldName/canRequestInvite/travelingToLocation`。
注意：avatar diff 事件的 `avatarName` 常为空（WS `currentAvatarName` 缺省），前端要 fallback 成“更换了头像”。

旧位置推断（对齐 VRCX GPS 的“旧→新”）：查该用户历史最近一条 `friend-location` 的 `content_json.location`。

## 坑：events 表没有 location 列

位置存在 `content_json` 里，不在独立列。`SELECT location FROM events …` 报 `no such column: location`。
该错误若被 `try/catch` 吞掉会**静默返回 null**，前端永远拿不到旧位置 —— 排查时要单独在容器里跑这条 SQL 看 stderr。
修复：`SELECT content_json …` 再 `JSON.parse` 取 `content.location / content.world.name`。

## 坑：VRChat API 参数组合挑剔（400）

- `/avatars?userId=me&n=40&order=updated&sort=descending` → **400**（不能 `userId=me`，不能带 `order`）
- 已验证正确组合（来自仓库 `test-apis.mjs`）：`/avatars?userId=<真实id>&n=&sort=updated`
- 通用套路：遇到 400 先 grep 仓库 `test-apis.mjs`/test 文件找已知可用调用；或拉官方 SDK 枚举确认取值（`sort_option.py` 的 sort 枚举、`order_option.py` 的 ascending/descending）。

## 同形字伪装检测（对齐 VRCX confusables.js）

- 前端维护 `CONFUSABLES` 映射（希腊/西里尔/全角字母/全角标点 → 拉丁）并 `flagName(name)=esc(name)+confusableFlag(name)`，替换所有玩家名渲染点（事件行/好友/资料/搜索/屏蔽/首页）。
- **关键坑：必须包含小写**。西里尔小写 `е` 是最常见的伪装（`Hеliox` vs `Helionix`）；只放大写会漏掉最常见场景。希腊、西里尔都要补小写。
- 验证用例：正常拉丁名、CJK 名不误报；`Hеliox`（西里尔 е）、`Αlpha`、`Ｈｅｌｌｏ` 命中。

## 远程只读 DB 探针（验证用，非业务代码）

容器查 SQLite：`docker exec <容器> node -e "<…node:sqlite DatabaseSync readOnly…>"`，prepared `SELECT` 后 `JSON.stringify` 打印。
用途：确认 `events` 表 distinct type、`content_json` 真实结构、计数 —— 避免“猜存储结构”。
注意：`node:sqlite` 的 ExperimentalWarning 打在 stderr，是正常的，别误判失败。

## 其它对齐中验证过的数据源（插件 api.vrchat.fetch / api.consume）

- 收藏 Avatar：`api.vrchat.fetch('/avatars/favorites?n=60')`
- 用户详情（曾用名/状态历史/注册日期）：`/users/{id}` → `pastDisplayNames`/`statusHistory`/`date_joined`
- 最近访问世界：`events` 里 `user-location`/`friend-location` 按 `world_id` GROUP BY + `LEFT JOIN world_cache` + `COALESCE(NULLIF(e.world_name,''), wc.name,'')` 回填名字
- 上线时段分布：`friend-online` 按 `strftime('%H', created_at)` 分组，前端 `svgBars({label,value})` 直接吃
- 玩家资料补全字段：friends 表有 `status_description/pronouns/bio/trust_level/memo` 列，`dashboard.friends` DTO 要带出（信任等级原始值如 `"Known User"`，前端映射勿只匹配裸 `known`）
