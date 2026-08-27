---
name: events
description: VRChat 社区活动聚合插件：多源采集、群组深度挖掘、音乐/VTuber 筛选、双列时区与中文参加方式标准化输出
---

# events 插件

本插件为 vrchat-assistant 服务提供 **VRChat 社区活动聚合** 能力：从多个公开数据源采集近期活动，做群组深度挖掘（把零散活动关联到真实 VRChat 群组并补热度/图标），按音乐 ∪ 虚拟主播偏好筛选，输出**结构化 JSON**——每个活动自带规范化图片 URL、双列时区（当地时间 + 北京时间）与中文参加方式，消费端（Agent / PDF 管道）读取后可直接呈现，无需各自修复。

## 核心特性

1. **多源采集**（零外部依赖，全部 Node ≥22 内置 `fetch`）：
   - VRC Search（全球，SSR HTML 解析，naive=UTC）
   - RLVRC（中文区，JSON API，北京时间）
   - VRCEve / VRCEvent-KR（日/韩，Google Calendar API v3，**需要使用者自己的 Google API Key**）
2. **群组深度挖掘**：三级反查——
   - ① 短码 `/groups/redirect/{sc}`（302 location → gid，无需认证）
   - ② 活动名关键词 `GET /groups?query=`（Jaccard 相似度 > 0.45 + 质量门槛 成员≥20/非泛化短名，防误配）
   - ③ 描述里写明的借用群组/世界名/店名
   - 已有关联群组的活动：补 `member_count`（热度）+ `icon_url`
3. **侧补充源**：`peekGroups=true` 时窥探已挖掘群组的公告（复用核心 `peek_group_announcement`）解析活动线索（有副作用，默认关）
4. **音乐 ∪ VTuber 筛选**：`focus=music` 时 `音乐∪VTuber`（排除 voice/language/learn/study 语音教育误报）
5. **数据后处理标准化**（`enrichEvent`，每个返回事件自动注入）：
   - `icon_url` / `image`：file URL 规范化 `.../file_xxx/<ver>/file`（单 `/file`，消除重复后缀）
   - `start_local` / `start_bj` / `tz_label` / `tz_offset`：双列时区（naive 当 UTC 按 languages 判社团时区：ja→JST+9 / ko→KST+9 / zh→+8 / ru→MSK+3 / 其他→美东 ET-4；aware 读自带偏移）
   - `join_info_zh`：VRCEve 日文 `【参加方法】` 规则化中文（加入群组房间「名」等）
   - `category_zh`：category 中文映射

## 工具

| 工具 | 说明 |
|------|------|
| `fetch_community_events` | 聚合采集 + 群组深挖 + 筛选，返回结构化 JSON |
| `get_community_events_config` | 查看 Google API Key 是否已配置（值存数据库，不回显） |
| `set_community_events_google_key` | 录入/清除使用者的 Google API Key（存数据库 `plg_events_config`，需 `confirm:true`） |

`fetch_community_events` 参数：
- `window`：`week | month | tonight`
- `focus`：`all | music | vtuber`
- `sources`：逗号分隔 `vrcsearch,rlvrc,vrceve,vrckr`（默认 all）
- `languages`：逗号分隔 `zh,ja,ko,en`（默认 all）
- `minMembers`：只保留群组人数 ≥ 该值
- `maxMine`：群组深挖的活动数上限（0~300，受 API 限流约 2.6s/个，短码优先）
- `peekGroups`：窥探已挖掘群组公告做侧补充源（有副作用：加入→读→退出）
- `startDate` / `endDate`：自定义日期（成对，**仅作用于 Google Calendar 源** VRCEve/VRCEvent-KR；VRC Search 固定抓 next-week/month、RLVRC 固定抓全量，不受此参数约束）
- `languages`：逗号分隔语言筛 zh/ja/ko/en（默认 all）。注：VRC Search 源活动 lang 标 `multi`（多语言），**视为通配**——任何语言筛下都保留，不会被 languages=zh/ja/en 筛掉
- `limit`：返回条数上限(≤500)

## Google Calendar API Key 配置

VRCEve / VRCEvent-KR 数据源需要使用者自己的 Google API Key（这三个源是 Google Calendar 公开日历）。**此 Key 是使用者的，不是本服务凭据**：
- 未配置时这两个源跳过，`fetch_community_events` 返回的 `configStatus.googleKeySetupGuide` 给出创建 Key 的指引网址
- 创建后经 `set_community_events_google_key` 录入（存数据库 `plg_events_config`，非明文配置文件）
- 也支持 `VRC_MONITOR_GCAL_CRED` 环境变量（注意避开 loader 敏感词，勿含 KEY/SECRET/TOKEN 等）

创建网址：<https://console.cloud.google.com/apis/credentials>（启用 Calendar API：<https://console.cloud.google.com/apis/library/calendar-googleapis.com>）

## 开发与验证

- 冒烟：`node plugins/local/events/smoke-events.mjs`（加载 + 注册 + dispatch + tool-order）
- 注册表完整性：`node test-registry.mjs`
- 文档漂移：`python scripts/check-doc-drift.py --json`
- 真实调用：`curl -N http://127.0.0.1:8799/mcp -X POST -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fetch_community_events","arguments":{...}}}'` → 取 `data:` 行的 `result.content[0].text`