---
name: vrchat-social-queries
description: "VRChat social queries: online, companions, patterns, boops."
version: 1.0.0
metadata:
  hermes:
    tags: [vrchat, gaming, social, friends, queries, boop]
    related_skills: [vrc-monitor-agent]
---

# VRChat 好友/社交域 — 查询工作流与写操作

本 skill 覆盖 **vrc-monitor 的好友/社交域**：在线列表、同房/同屏、上线规律、常玩统计、社交画像、关系分析、昵称管理，以及全部社交写操作（boop / 上传 / 邀请 / 开房 / 好友管理）。

> ⚠️ **工具表唯一权威在 vrc-monitor-agent skill**（全部 MCP 工具及参数）。本 skill 只写工作流与域内细节，不复制工具表。通用 MCP 调用陷阱（`data:` 前缀、MCP 入参格式）见 vrc-monitor-agent「常见陷阱」。
> MCP 端点：`http://127.0.0.1:8799/mcp`；服务未启动处理见 vrc-monitor-agent「服务健康检查」。

## 1. 好友在线列表

用户问"现在有哪些好友在线 / XX 在线吗"时，**直接调 `get_online_friends`**，一条调用拿全要素：昵称（有本地昵称用昵称）｜所在世界｜房间类型｜在线时长｜房间停留时长。

返回的每条好友记录含：

| 字段 | 说明 |
|------|------|
| `nickname` | 本地昵称（null = 无；展示用 nickname \|\| displayName） |
| `locationParsed` | 结构化房型：worldId/instanceId/type（public/hidden/friends/group/private/local）/ownerId/region |
| `worldName` | 世界名（缓存优先，未缓存自动批量 API 查询并写 world_cache；查询失败/private 为 null） |
| `onlineMinutes` / `onlineSince` | **本次在线时长**：会话起点 = 最近 friend-offline 之后最早的一条 friend-online（WS 重连会重复推送 friend-online，取最新会严重低估，MIN(>last_off) 跳过重复推送）；无 offline 记录 = 取最早 friend-online |
| `durationMinutes` / `enteredAt` | **房间停留时长**：进入时间 = max(会话起点, 最新位置事件时间)（防跨会话污染）；null = 未知（traveling/无匹配事件） |

展示紧凑表格（**五列**）：`| 好友 | 世界 | 房型 | 在线 | 停留 |`；房型中文图标 🌐公开/🤫隐藏/👥好友房/🏷️群组房/🔒私密/💻本地；同房好友（完整 location 相同）额外高亮。⚠️ private 房停留时长可算但语义是"位置隐藏前最后一次更新"，参考价值低。

## 2. "XX 现在和谁一起？" / 同实例好友

```
1. get_friend_info(userId=目标) → 取 location 字段（如 "wrld_xxx:77182~hidden(usr_owner)~region(jp)"）
2. get_online_friends() → 所有在线好友的位置
3. 按完整 location 字符串匹配 → 同实例的好友
4. 从 location 解析 owner：hidden(usr_xxx)/private(usr_xxx)/friends(usr_xxx)/group(grp_xxx)
5. get_world_name(worldId) → 世界名（location.split(':')[0]）
```

- 只能看到你也是好友的人（API 限制）
- `~hidden(usr_A)` = A 的隐藏房；`~private(usr_B)` = B 的私密房；`~friends(usr_C)` = C 的好友房
- 直接读 `get_online_friends` 返回的 `locationParsed` 字段即可（type/ownerId/worldId/instanceId/region 已结构化），不需要手写解析

## 3. "今天和谁一起玩了？" / 同屏交叉查询 → `get_companions`

**⚠️ 不要委派子 agent 做同屏查询**——子 agent 只会查少量已知 userId，会漏掉其他人。直接用 MCP 工具：

```bash
curl -s http://127.0.0.1:8799/mcp -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_companions","arguments":{"startTime":"<UTC起>","endTime":"<UTC止>","userId":"<目标userId，可省略=当前账号>"}}}'
```

- `startTime`/`endTime`：ISO 8601 UTC（北京时间 -8h），窗口 ≤24h
- `userId`：可查自己（默认）或任意好友——传好友 ID = "XX 和谁一起玩过"
- 原理：查目标用户的 location 事件（自己=`user-location`，好友=`friend-location`）→ 提取 worldId:instanceId → 全量比对好友 location 事件 → 排除目标本人 → 按 userId 分组
- **companions 条目字段**：`userId / displayName / firstSeen / lastSeen / matchCount / worlds[]`。⚠️ **`worlds` 是字符串数组**（元素 = `world_name || world_id`），不是对象数组；同屏频率看 `matchCount`（同屏次数），没有 totalDuration 字段
- 解析响应：SSE `data:` 前缀剥掉后 `result.content[0].text` 再 json.loads；MCP 入参直接传参数对象，不要包两层

## 4. "某天活动时间线" / "XX 和 YY 昨晚同房吗"

```
1. get_friend_events(userId=A, types="friend-location", limit=5) → 最近位置变化
   - created_at 是 UTC，+8 转北京时间
   - location 格式 "wrld_xxx:instanceId~hidden(usr_owner)~region(jp)"；traveling 时看 travelingToLocation
2. 比对 worldId + instanceId：相同 = 同房；确认时间重叠
3. get_world_name(worldId) → 世界名
```

**陷阱：** `get_friend_events` 每个事件嵌完整用户 JSON（~50KB），limit 大会爆响应。用 `limit=5` + `offset` 分页；或只读顶层 `created_at`/`world_id`。同一世界不同 instance ID = 不同房。

## 5. "XX 几点上线 / 什么时候最容易碰到 TA" → `get_online_pattern`

一次调用拿全部规律，不要逐条翻事件：

```bash
curl -s http://127.0.0.1:8799/mcp -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_online_pattern","arguments":{"userId":"<目标userId>"}}}'
```

- `userId`：必填。`days`：可选，默认 30（北京时间自然日，含今天）。`startTime`/`endTime`：可选 UTC 窗口，优先于 days
- 返回：`hourly`（上线/下线/位置活跃按北京小时分桶）、`activeDates`（活跃日期）、`frequency`（windowDays/activeDays/activityRatio/avgGapDays/longestGapDays）、`peak`（loginPeakHour/activePeakHour/offlinePeakHour/suggestedWindow）
- `suggestedWindow` 可直接作"最佳相遇时段"；展示分布用紧凑小时柱状图；频率看 `activityRatio` 和 `last30ActiveDays`
- ⚠️ **查自己时 `online/offline` 恒为 0**（VRChat WS 不推送自己的上下线事件，只有位置变化）——自己的"上线规律"= 活跃分布推断，报告要标注口径

## 6. "经常一起玩的好友现在谁在线" / 常玩好友统计

三件套：在线列表 + 逐日同屏 + 交叉。**在线 ≠ 一起玩过**——在线列表里几天内真正同屏过的往往只有少数，别把整个在线列表当"常玩"。

```
1. get_online_friends → 当前在线好友
2. 逐日调 get_companions（自己 userId；窗口 ≤24h，北京时间自然日 = UTC 16:00 日界，N 天 = N 次调用）
3. 与 get_nicknames 结果交叉 → 带昵称展示
```

- 统计口径：同屏 ≥2 天 = 核心圈；1 天 = 偶尔碰到。展示用紧凑表格 + 一行小结
- 批量查询建议在脚本里用 urllib 循环调 MCP（30 次调用约 6s），比逐次 curl 高效

## 7. 昵称管理

好友昵称映射存本地库（`nicknames` 表），**不维护在 skill 文件里**：

- 查询：`get_nicknames`（无参返回全部；`userId` 精确查；`query` 按昵称或显示名模糊查）
- 写入：`set_nickname {userId, nickname, displayName?}`（upsert 幂等）
- 建议工作流：用户给好友取中文昵称 → `search_users` 找 userId → `set_nickname` 写入 → 后续查询结果用昵称展示
- 用户报音近名（语音识别歪）时，先 `get_nicknames` 模糊查再搜，不要直接搜

## 8. "XX 什么时候去过 Y 世界？" / 访问时间线

直查 SQLite（只读）比 MCP 分页高效（数据库文件在项目目录，WAL 模式可并发读）：

```python
con = sqlite3.connect(r'file:<项目目录>/data/vrc-monitor.sqlite3?mode=ro', uri=True)
cur.execute("SELECT created_at, content_json FROM events WHERE user_id=? AND type='friend-location' AND world_id=? ORDER BY created_at", (UID, WID))
```

- 先按 `GROUP BY world_id` 数次数 + world_name 确认目标世界
- **访问次数 ≠ 事件条数**：同一实例连续多条事件合并成一次访问——相邻事件间隔 >2h 切分为新访问。⚠️ **不能按 instanceId 合并**：隐藏/群组房 instanceId 是房主 userId，跨天会复用
- 展示：北京时间 +8，紧凑表格 `| # | 进入时间 | 停留 |` + 一行小结

## 9. 好友社交画像报告

用户要"TA 最近和谁玩 / 常去哪些世界 / 上线规律"时，四步拼装：

1. `get_online_pattern(userId)` → 上线规律（活跃率/峰值/建议时段）
2. SQLite 世界统计：`friend-location` 按 world_id GROUP BY 计数 + 时间范围（**private 单独计数**——私密房占比高说明近期活动不可见，报告注明）
3. 逐日 `get_companions(userId=<TA>)`（窗口 ≤24h）→ 同屏天数/总次数/最近日期，昵称从 nicknames 表匹配
4. 活动明细：查某天 friend-location 顺序 → 时间线（案例模式：一晚巡游多个世界、多人同屏）
5. 生成 markdown 报告 → 文件发送（聊天里只给核心摘要 + 紧凑表格）

## 10. "我和 XX 的关系分析"

1. `get_friend_info(userId=XX)` → 好友状态/bio/lastLogin/当前 location（bio 常含羁绊名单，与共同好友交叉 = 介绍人线索）
2. `get_mutual_friends(userId=XX)` → 共同好友（自动带本地昵称），重叠度 = 圈层接近度
3. 逐日 `get_companions(自己 userId)` → 过滤目标 userId，累计同屏天数/matchCount/worlds
4. 综合：同屏频率与近期趋势（升温/降温）、共同好友里的核心圈成员、时段重合度

- **实时情报**：`get_friend_info` 的 location 能看出 TA 此刻在谁房里
- **群组画像辅助**：`get_user_groups` + 批量 `get_group_info` 拿描述 → 按群规模分层（大社区/亲友群/技术核心组）判断融入深度（群组域见 vrchat-group-queries）
- 展示：好友信息卡片 + 共同好友表 + 同屏时间线表 + 关系小结

### 10.1 "谁把我删了" / 好友解除记录（friend-delete）

**触发**：用户问「谁删除我了 / XX 是不是把我删了 / 为什么好友少了」。

1. `get_friend_removals()` → 列出全部 friend-delete（friend-removals 插件工具）：每条 userId/displayName（回填其最后使用名）/nickname/createdAt
2. 按时间筛近期：`get_friend_removals({ days: N })`；怀疑单个人：`get_friend_removals({ userId })`
3. 佐证/深挖（确认是谁 + 疏远原因）：对目标 `get_friend_info`（读其 bio/status，如"会清理长期黄灯好友"类自述）→ `get_companions(自己)` 过滤该人看最近同屏 → `get_friend_events` 查对方最后活跃时间，判断删除是"清理型"还是"冲突型"

**口径提示**：friend-delete = 对方解除好友（VRChat WS 推送），非 `remove_friend`（自己删）。事件不带对方名字，显示名由插件回溯其历史事件回填；本服务未运行期间发生的删除无法补测。原始数据也可经 `get_recent_events(typeFilter="friend-delete")` 查（核心 SQL 层类型检索，2026-09-06 起可查全史）。

## 11. 社交写操作（boop / 上传 / 邀请 / 好友 / 开房）

> 写操作参数见 vrc-monitor-agent 工具表。⚠️ **不可逆操作（remove_friend / remove_print / remove_gallery_image）必须 `confirm: true` 才执行**，否则只返回预览。

### 11.1 戳一戳（boop）与 emoji
- `send_boop {userId, emojiId?}`：戳好友。⚠️ **MCP 响应空文本≠失败**（content[0].text 偶发空串）——空响应不代表失败，看 raw 响应确认 `booped:true` 即成功。发出的 boop 不落库，只能以 raw 响应为准
- `get_boop_emojis`：内置 emoji 列表 + emojiId 格式（`default_<name 小写下划线>`）
- `upload_emoji {imagePath}`：自定义 emoji 上传（需 VRC+）；⚠️ **必须正方形**，先裁方再传

### 11.2 照片→自定义 emoji→戳人 流水线
1. 取图（聊天图片缓存）→ 留底
2. 裁方：`prepare_image.py --mode square --mode-detail fit --size 1024`（⚠️ Windows 下脚本路径用引号包裹的绝对路径，防 MSYS 路径转换）
3. `upload_emoji {imagePath: <方形图>}` → `fileId`
4. `send_boop {userId, emojiId: fileId}`

**⚠️ upload_emoji multipart 坑**：① JSON 参数必须拆成独立 multipart 字段（`tag`/`maskTag`/`animationStyle` 各占一个 form-data 字段，打包成单个 JSON → 400 `tag is required`）；② 文件字段名固定 `file`；③ **`animationStyle` 必填**（静态图传 `'stop'`）；④ 成功标准 = 返回 `fileId`，`GET /files?tag=emoji&n=20` 可见

### 11.3 相册/图库
- `upload_print {imagePath, note?}` / `upload_gallery_image {imagePath}`（需 VRC+）；⚠️ gallery 上传必须显式 `contentType: image/png`（默认 blob 无扩展名会报 "must be an image"）
- `get_prints` / `get_gallery_images`：列表即带 downloadUrl
- `remove_print` / `remove_gallery_image`：⚠️ 不可逆，必须 confirm: true
- `download_print` / `download_gallery_image`：下载到本地（可 MEDIA 发送）；⚠️ **VRChat 文件 URL 会 302 到 CDN 签名 URL——必须跟随重定向**
- **上传前图片处理**：Prints/Gallery 用 `prepare_image.py --mode landscape --ratio 16:9|4:3`——**竖图自动旋转 90°** 变横图（内容跟着转）；`--strategy auto` 比较裁剪损失 vs 填充白边，损失小的优先

### 11.4 邀请与开房
- `send_invite {userId, worldId, instanceId, message?}`：拉人进房；`request_invite {userId, message?}`：请求被邀请
- `create_instance {worldId, type?, region?}`：创建实例（默认 hidden/jp）；⚠️ **非 public 必须显式带 ownerId=当前用户**（不带 400 "Invalid owner ID"）；返回 location 可直接给 invite_myself
- `invite_myself` / `open_world`：同一引擎（core/vrchat-launch.js openInstance）——**管道直发优先**（Windows 游戏内静默弹加入菜单），探测失败**静默回退** API 邀请（`method: "api"` = 回退态，非失败）。⚠️ open_world 的 id 必须是完整 location（含实例号），只传 worldId 游戏内无反应
- 开图后验证：**直接问用户，别截图**（给「进了世界/弹错误/没反应」选项）
- 链路：`scan_new_worlds`（候选）→ `create_instance`（建 jp 房）→ `invite_myself`（传送）；API 创建实例不改变 presence，传送必须由客户端执行

### 11.5 好友管理
- `send_friend_request {userId|displayName}`：加好友（精确匹配不区分大小写）
- `remove_friend {userId|displayName}`：⚠️ 不可逆，必须 confirm: true，否则只返回预览。测试只走零副作用路径
- `get_mutual_friends {userId}`：共同好友（自动带本地昵称）

### 11.6 隐私位置场景（boop 目标定位）
- **好友位置显示 `private` ≠ 不在线/不在你房间**：VRChat 隐私设置可让位置对好友隐藏，且该好友可能不出现在 `get_online_friends` 列表。定位流程：`search_users` 按 displayName 子串搜 → 确认 `isFriend: true` → `get_friend_info` 确认 `state: online` → 直接 boop
- 同房判断别只靠 location 字段：隐私设置下只能用用户口述 + boop 回执验证
- **对方没收到戳戳 → 重发一次**（boop 通知 24h 内有效，可能被顶掉/漏显示，重发是标准补救）
- 中文名搜索不可靠时，若目标在线可先扫 `get_online_friends` 的 displayName 找音近名

## 12. 域内陷阱与已知缺陷

### boop 通知在 notification-v2 里
boop 通知落库的顶层事件类型是 `notification-v2`（不是 `boop`），boop 在 `content_json.type` 里。`get_recent_events(typeFilter="boop")` 查不到 → 用 `typeFilter="notification-v2"`。

### get_companions 查好友返回空（历史缺陷，已修复）
早期版本只查 `type='user-location'` 事件（那是登录账号自己才有的类型），好友的位置事件是 `friend-location`，导致传好友 userId 查询永远空。已修复：目标用户事件类型扩展为 `IN ('user-location','friend-location')` + 交叉匹配排除目标本人。**再遇"查好友同屏为空"**：确认 storage.js 的 findCompanions 带 `type IN` 条件；改代码后必须重启服务才生效（进程常驻，不热加载）。

### 用户自己的位置事件没有独立 worldId 字段（已修复）
自己的位置事件 content 只有 `location` 字符串，没有 `worldId` 字段（好友的 friend-location 才有）。已加 `_handleUserLocation` 从 location 字符串解析落库。查自己世界访问历史：`SELECT world_id, COUNT(*), MAX(created_at) FROM events WHERE type='user-location' AND world_id!='' GROUP BY world_id`。
