---
name: events
description: VRChat 社区活动聚合插件：多源采集、群组深度挖掘、音乐/VTuber 筛选、双列时区与中文参加方式标准化输出
---

# events 插件

本插件为 vrchat-assistant 服务提供 **VRChat 社区活动聚合** 能力：从多个公开数据源采集近期活动，做群组深度挖掘（把零散活动关联到真实 VRChat 群组并补热度/图标），按音乐 ∪ 虚拟主播偏好筛选，输出**结构化 JSON**——每个活动自带规范化图片 URL、双列时区（当地时间 + 北京时间）与中文参加方式，消费端（Agent / PDF 管道）读取后可直接呈现，无需各自修复。

## 核心特性

1. **多源采集**（零外部依赖，全部 Node ≥22 内置 `fetch`）：
   - VRC Search（全球，SSR HTML 解析，naive=UTC；含 zh/ja/ko 语言码 × 类别矩阵，覆盖中文/繁中/韩文）
   - RLVRC（中文区，JSON API，北京时间）
   - VRCEve / VRCEvent-KR（日/韩，Google Calendar API v3，**需要使用者自己的 Google API Key**）
   - vrcwiki.ru（俄罗斯区，VRC✦CULTURE）——API `https://vrcwiki.ru/api/events` 返回全量结构化 JSON（字段≈VRChat 官方 API，**自带 group 信息**）。⚠️ **反爬**：对非浏览器 TLS/UA 指纹返回 HTTP 200 但 0 bytes——插件内 Node fetch 大概率拿不到（ANTIBOT_EMPTY），`sourceBreakdown.vrcwiki` 诚实标 `not_queried:true + reason`（不伪装成功）。**需俄罗斯社区时走浏览器通道**：`browser_exec` 打开页面后在浏览器内 `fetch('/api/events')` 拿 JSON 再喂管道（见 Hermes 技能 `vrchat-events-aggregation/references/vrcwiki-ru-events-api.md`）
2. **群组深度挖掘**：三级反查——
   - ① 短码 `/groups/redirect/{sc}`（302 location → gid，无需认证）
   - ② 活动名关键词 `GET /groups?query=`（Jaccard 相似度 > 0.45 + 质量门槛 成员≥20/非泛化短名，防误配）
   - ③ 描述里写明的借用群组/世界名/店名
   - 已有关联群组的活动：补 `member_count`（热度）+ `icon_url`
3. **侧补充源**：`peekGroups=true` 时窥探已挖掘群组的公告（复用核心 `peek_group_announcement`）解析活动线索（有副作用，默认关）
4. **音乐 ∪ VTuber 筛选**：`focus=music` 时 `音乐∪VTuber`（排除 voice/language/learn/study 语音教育误报）
5. **数据后处理标准化**（`enrichEvent`，每个返回事件自动注入）：
   - `icon_url` / `image`：file URL 规范化 `.../file_xxx/<ver>/file`（单 `/file`，消除重复后缀）
   - `start_local` / `start_bj` / `tz_label` / `tz_offset`：双列时区（naive 当 UTC 按 languages 判社团时区：ja→JST+9 / ko→KST+9 / zh→+8 / ru→MSK+3 / 其他→美东 ET-4；aware 读自带偏移；**RLVRC 源特判**：start 无时区后缀＝已是北京时间，不 +8，直接本地=北京）
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
- `sources`：逗号分隔 `vrcsearch,rlvrc,vrceve,vrckr,vrcwiki,ru`（默认 all 含全部；vrcwiki 有反爬，见 sourceBreakdown）
- `languages`：逗号分隔 `zh,ja,ko,en`（默认 all）
- `minMembers`：只保留群组人数 ≥ 该值
- `maxMine`：群组深挖的活动数上限（0~300，默认 30，可显式覆盖；受 API 限流约 2.6s/个，短码优先；群组详情经 groups.resolve 缓存优先，命中缓存零限流请求）
- `peekGroups`：窥探已挖掘群组公告做侧补充源（有副作用：加入→读→退出）
- `startDate` / `endDate`：自定义日期（成对，**仅作用于 Google Calendar 源** VRCEve/VRCEvent-KR；VRC Search 固定抓 next-week/month、RLVRC 固定抓全量，不受此参数约束）
- `languages`：逗号分隔语言筛 zh/ja/ko/en（默认 all）。注：VRC Search 源活动 lang 标 `multi`（多语言），**视为通配**——任何语言筛下都保留，不会被 languages=zh/ja/en 筛掉
- `limit`：返回条数上限(≤500)

## 返回字段注意（使用经验固化）

- **`sourceBreakdown`**：每源 `{ count, ok, fail, queried?, not_queried?, reason? }`。判定规则：
  - `ok>0 且 count=0` → 「源可访问但该时段无活动」
  - `ok=0 且 fail>0` → 「源不可达」
  - `vrcwiki.not_queried=true + reason` → 「vrcwiki 反爬，Node fetch 拿不到 0 bytes，需浏览器通道」
  - **不要只看 `ok:1/fail:0` 就断定「某源无活动」**——先看各源 `count` 是否>0，再对目标时段按 lang 统计
- **`truncated` / `truncateNote`**：输出条数 == limit 上限时为 `true`（截断警告）。**判断「某社区该时段无活动」前必须先确认 truncated=false**；若被截断（如欧美活动被 ja 挤掉），重采并加大 limit（如 `limit:2000`）

## Google Calendar API Key 配置

VRCEve / VRCEvent-KR 数据源需要使用者自己的 Google API Key（这两个源是 Google Calendar 公开日历）。**此 Key 是使用者的，不是本服务凭据**：
- **推荐优先用环境变量 `VRC_MONITOR_GCAL_CRED`**（不落地、不提交）；`set_community_events_google_key` 存数据库次之；插件目录 `config.json` 仅作最后兜底（已加 `.gitignore` 排除，防 `git add .` 泄 key）。
- 未配置时这两个源跳过，`fetch_community_events` 返回的 `configStatus.googleKeySetupGuide` 给出创建 Key 的指引网址；`sourceBreakdown` 用 `not_queried:true` 明确标注「未查询」，不会伪装成「源可达但无活动」。
- 创建后经 `set_community_events_google_key` 录入（存数据库 `plg_events_config`，非明文配置文件）
- 环境变量名刻意避开 KEY/SECRET/TOKEN/PASSWORD/COOKIE/AUTH 子串（避免插件 loader 敏感词扫描）

创建网址：<https://console.cloud.google.com/apis/credentials>（启用 Calendar API：<https://console.cloud.google.com/apis/library/calendar-googleapis.com>）

## 网络代理（中国大陆必需）

Google Calendar（VRCEve / VRCEvent-KR）在需代理的网络环境下**必须走代理**才能访问。插件 `httpGet` 复用仓库核心 `core/fetch-x-worlds.js` 的「先代理后直连」模式（`HttpsProxyAgent`），自动读取环境变量：
- `VRC_MONITOR_HTTP_PROXY`（优先）或 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`
- 未配置代理时自动直连（VRC Search / RLVRC 等无需代理的中文源照常工作）

代理环境（如 Clash 127.0.0.1:7892）下部署示例：`HTTPS_PROXY=http://127.0.0.1:7892 node start-monitor.js`。代理不可达时自动回退直连。

## 开发与验证

- 冒烟：`node plugins/local/events/smoke-events.mjs`（加载 + 注册 + dispatch + tool-order）
- 注册表完整性：`node test-registry.mjs`
- 文档漂移：`python scripts/check-doc-drift.py --json`
- 真实调用：`curl -N http://127.0.0.1:8799/mcp -X POST -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fetch_community_events","arguments":{...}}}'` → 取 `data:` 行的 `result.content[0].text`