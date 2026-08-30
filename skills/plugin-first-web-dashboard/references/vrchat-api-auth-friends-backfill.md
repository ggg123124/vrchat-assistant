# VRChat API 认证 / 好友头像回填 / 事件文案 踩坑记录

> 会话实测：好友头像灰色、资料页模型名缺失、事件文案被用户纠正后的正确做法。
> 与 `vrcx-data-parsing-and-api-gotchas.md` 互补（本篇聚焦 auth、friends 全量、头像字段、显示文案）。

## 坑：`/auth/user/friends` 默认只返回在线好友（offline=false）

- 不传参数（或只传 `n=&offset=`）时**默认 `offline=false`** —— 在线 0 人时返回**空数组**。
- 要拿**全部好友（含离线）**必须显式 `offline=true`：`/auth/user/friends?offline=true&n=100&offset=0`（分页 `n=100`，`data.length<100` 即最后一页）。
- **VRCX 能显示离线好友头像的原因就是它用 `offline=true`**。本会话头像回填一度 updated=0 无日志，根因就是漏了这个参数（不是 API 不返回头像）。

## 坑：头像字段名是 `currentAvatarImageUrl` 不是 `avatarImageUrl`

VRChat API User 对象的头像字段：
- `currentAvatarImageUrl`（大图）
- `currentAvatarThumbnailImageUrl`（缩略图）
- `userIcon`（小图标）

写回填/抓取逻辑时用 `f.avatarImageUrl` 会**恒为空**（字段不存在 → `if(!av) continue` 全跳过、静默 updated=0）。判断“有头像”用 `currentAvatarImageUrl || currentAvatarThumbnailImageUrl || userIcon`。

## 坑：`/auth/user`（me）不返回 `currentAvatarName`

拿“当前模型名字”不能靠 `me.currentAvatarName`（恒空）。正确做法：从**已拉取的上传模型列表**里按 `currentAvatar === avatarId` 匹配出 `name` 再回填。前端 avtr 页同理：有 `currentAvatar`（id 必返）时优先展示 id，名字尽力而为。

## 坑：直接 HTTP 调 VRChat API 的认证头

- 认证用 **`Cookie: auth=<值>`**（不是 `Authorization: Bearer`，后者 403）。
- **必须带 `User-Agent`** 且含应用名/版本（如 `VRCX-0-Actions-MCP/1.0`），否则 403 `please identify yourself`。
- 项目内走 `api._request` / `VrchatApiClient`（内部已带 UA + cookie，`loadCookieFromFile('/app/data/auth_cookie.txt')`），别自己拼 header。

## 网页在线判定（修正版）

`isWebOnline = isOnline && (platform 含 web || location==='offline' || worldId 非 wrld_ 开头且非 traveling)`。
- VRChat 网页在线特征：`isOnline=true` 但 `location='offline'` 或 `worldId='private'`（不进实例）。
- 只判 `platform==='web'` 会误判：网页在线好友的 platform 可能是 `standalonewindows`，位置显示成“桌面在线（私人房）”。
- 单测覆盖：`{platform:'standalonewindows', location:'offline'}`→true；`{worldId:'private'}`→true；`{worldId:'wrld_x'}`→false；`{worldId:'traveling'}`→false。

## 事件显示文案（用户定稿，逐字遵守）

- 位置变化 → **“位置变化”**；detail 显示**世界名**（`previousWorldName → worldName`），**不是**实例权限/服务器（如 `Friends+ · JP` 是房间权限+服务器，用户明确不要）。实例信息只放展开详情的“实例：”行。
- 上线 → **“上线”**（不是“上线并开始活动”）。
- avatar 变更 → **“更换模型”**（不是“头像”）；有名字显示“更换模型 · 名”，有 `avatarId`（`currentAvatar`）显示 `avtr_xxx`。
- status 变更 → **“状态变化”** / detail “状态：<statusDescription>”。
- bio 变更 → **“简介变化”**。
- 事件行 world 列的实例标签（`Public · JP`）只在 `locLabel(x.location)` 解析出**非空**时才渲染——传送中事件 location 有值但 locLabel 为空，会造成**空的实例框**，必须用 locLabel 结果判空而非 location 判空。
- `start-monitor.js` 里有**两处** summary 构造（`dashboard.events` 与 friend-events 服务），改文案要 grep 两处都改，改完 grep 残留字符串验证。

## 容器内跑复杂 JS 的验证技巧（避免 bash 转义地狱）

bash 双引号里 `$(`、嵌套引号、模板字符串 `${...}` 会被 shell 破坏。两个可靠姿势：

1. **base64 包裹**（单行/中等脚本）：
   `docker exec <容器> node -e "eval(Buffer.from('<base64>','base64').toString())"` —— 本地先 `base64.b64encode(js.encode())`，Python 里拼命令。
2. **sftp 传脚本 + docker cp**（多行脚本）：本地 sftp 写 `/tmp/x.mjs` → `docker cp /tmp/x.mjs <容器>:/tmp/x.mjs` → `docker exec <容器> node /tmp/x.mjs`。
   - 容器内 import 依赖用 `createRequire('/app/package.json')`（better-sqlite3 等）避免绝对路径报 `ERR_MODULE_NOT_FOUND`。
   - DB 文件名以实际为准：`/app/data/vrc-monitor.sqlite3`（不是 assistant.db）。

## 坑：删 HTML 元素必须同步清 JS 裸引用（会崩整个 Dashboard）

去掉 UI 元素（导航去重/连接状态去重）时，如果 JS 里还有 `document.querySelector('#xxx').textContent=…` 裸引用，元素不存在 → `TypeError: Cannot set properties of null` → **load() 中断，页面白屏/请求失败**。
- 删 DOM 前 grep 前端 JS 对该 id/class 的引用；裸引用要么删要么加 `if(el)` 保护。
- 本会话真实事故：删除顶栏 connection/侧栏 rightAuth/rightWs 后 load() 三处裸引用崩溃 → 用户报“dashboard请求失败”。教训：**UI 清理 = 改 HTML + 同步审 JS**。
