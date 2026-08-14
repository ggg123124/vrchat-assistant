---
name: booth-query-display
description: "Use when the user asks to search/query BOOTH (booth.pm) items, show BOOTH item rankings, or display BOOTH products with covers, CNY prices, and popularity. Covers search, detail fetch, cover images, Japanese-to-Chinese naming, and the fixed display format."
version: 1.0.0
metadata:
  hermes:
    tags: [booth, pixiv, vrchat, assets, shopping, display-format]
---

# BOOTH 商品查询展示 Skill — 搜索/热度榜/封面/汉化/格式化输出

本 skill 固化「查询 BOOTH（booth.pm）商品并按固定格式展示」的完整工作流。适用场景：用户要求查 Booth 商品、查 VRChat 素材热度榜、展示商品列表（含封面、人民币价格、热度）。

## 触发条件

- 「查询 Booth / booth.pm 商品」
- 「Booth 热度前 N」/「Booth 排行」
- 「展示 Booth 商品」/「附封面展示」
- 用户要求查 VRChat 相关素材（avatar/衣装/3D 模型）在 Booth 的售价与热度

## BOOTH 缓存交互规则（用户拍板 2026-08-14）

查询 BOOTH 商品时按以下规则决定实时/缓存（**不要无脑询问**）：

1. 用户明确说要查**新的/最新/实时** → `get_booth_item` 带 `forceRefresh: true` 强制实时抓取
2. 用户未明确 → **默认走本地缓存**（`get_booth_history` / `get_booth_searches` 查历史；`get_booth_item` 缓存命中直接返回 `cached:true`）
3. 仅当**拿不准用户意图**时才询问一句（如"要最新的还是查过的？"）

> 缓存未命中时代码自动实时兜底（`get_booth_item` 缓存 miss 后直接抓取并落库），无需文档重复。

## 落库缓存功能（并入本 skill，Issue #28 实现）

BOOTH 查询结果**自动落库**（本地 SQLite `booth_items` / `booth_search_history` 表，旁路缓存——落库失败不影响实时返回）：

| 工具 | 说明 |
|------|------|
| `search_booth_items` | 搜索命中即 upsert 商品快照到 `booth_items`，记录搜索历史 |
| `get_booth_item` | 单品查询命中即落库；**缓存命中返回 `cached: true`**（不抓 BOOTH）；`forceRefresh: true` 强制实时 |
| `get_booth_history` | 查已落库商品快照（按收藏数/更新时间排序，`minWishlist` 趋势过滤）——"上周查过哪件衣服" |
| `get_booth_searches` | 查搜索历史（搜索词 + 结果 + 时间） |

- 收藏数（wishlistCount）是 BOOTH 唯一公开热度信号，落库后可做**趋势跟踪**（哪件在涨、接近售罄）
- 重复搜索同词优先走缓存，避免触发 booth.pm 限流
- 服务重启数据仍在（SQLite 持久化）；老库升级自动建表（IF NOT EXISTS 幂等）

## 浏览器访问流程（重要修正）

**优先使用电脑的默认浏览器**，而非临时启动的调试实例：

1. **检测默认浏览器**（Windows）：
   ```bash
   reg query "HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice" | grep ProgId
   # MSEdgeHTM → Edge；ChromeHTML → Chrome；FirefoxURL → Firefox
   ```
2. **用默认浏览器打开目标页**（如 Booth 登录页）：
   ```bash
   # 默认浏览器直接打开 URL（Windows 用 start / cmd /c start）
   cmd //c start "" "https://booth.pm/users/sign_in"
   # 或显式指定浏览器路径（Edge 示例）
   "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "https://booth.pm/users/sign_in"
   ```
3. **需自动化接管时**：给默认浏览器附加 CDP 调试端口启动（**必须带独立 `--user-data-dir`**，避免与用户日常浏览会话冲突）：
   ```bash
   EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
   "$EDGE" --remote-debugging-port=9222 --user-data-dir="$LOCALAPPDATA/Temp/edge-debug-profile" --no-first-run "URL"
   # Chrome 同理；CDP 端点 http://127.0.0.1:9222/json
   ```
4. **手动登录页场景**（reCAPTCHA 等无法自动化的）：
   - 优先用默认浏览器打开页面让用户操作，或
   - 用上述 CDP 实例打开——**登录窗口会出现在该实例中**，提示用户在对应窗口完成登录（可能与你日常浏览窗口并存，注意区分）

> 经验：本机默认浏览器为 Edge（MSEdgeHTM）。`browser_exec` 工具默认连 Chrome，若 Chrome 未授权远程调试，改走默认浏览器 + CDP 更顺。

## 数据源与限制（必读）

- **搜索页**：`https://booth.pm/ja/search/{关键词}?page=N`（HTML，每页约 60 个商品，关键词用 `encodeURIComponent`）
- **商品详情 JSON**：`https://booth.pm/ja/items/{id}.json`（匿名可访问，无需登录）
  - 关键字段：`name`、`price`、`wish_lists_count`（收藏数=热度）、`shop.name`、`tags`、`images[0].original`（封面原图，**QQ Bot 场景默认跳过，用户确认后按需抓取**）、`is_sold_out`、`url`
- **⚠️ 下载量/销量不可查**：Booth 公开页面不展示下载量，`past_purchase_count` 匿名恒为 0（仅卖家后台可见）——**用收藏数（wish_lists_count）作为热度信号**
- **网络**：booth.pm / booth.pximg.net 国内需代理；请求带浏览器 UA（`Mozilla/5.0 ... Chrome/126.0 Safari/537.36`）与 `Accept-Language: ja,en;q=0.8`；15s 超时
- **汇率**：实时查 `https://open.er-api.com/v6/latest/JPY` 的 `rates.CNY`（失败用兜底 ~0.048）

## 查询工作流

### 1. 收集商品 ID（搜索页解析）
```
GET https://booth.pm/ja/search/{encodeURIComponent(关键词)}?page={1..N}
```
- 商品链接正则：`/href="(?:https:\/\/booth\.pm)?\/ja\/items\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g`
- **注意**：同一商品有多个 `<a>` 链接（缩略图空链接 `<a></a>` + 标题链接 `<a>标题</a>`）——跳过空链接块，取含文本的链接；去重 ID
- 默认排序是「综合」，热门商品集中在前列，取前 3 页（~180 个）足够 TOP 榜

### 2. 批量查询详情（取热度）
```
GET https://booth.pm/ja/items/{id}.json   # 逐个查询，间隔 ~0.4s，单卡失败跳过
```
提取：name / price / wish_lists_count / shop.name / images[0].original / url

### 3. 排序取 TopN
按 `wish_lists_count` 降序取前 N（默认 15）

## 展示格式（用户固化要求，严格遵守）

> ⚠️ **QQ Bot 场景（重要）**：当请求来自 QQ Bot（gateway 平台为 `qqbot`，会话上下文带 QQ 平台标识）时，**默认不爬取封面图**——QQ 消息无法直接渲染外部图片链接，且逐个商品爬取 pximg 图片耗时较长。此时：
> - 封面列省略，格式降级为：`| 序号 | 商品名称（汉化） | 商家名 | 价格 | 人民币价 | 热度 | 链接 |`
> - 其余字段规则不变；数据采集流程中跳过 `images[0].original` 的获取/输出
> - **输出列表后必须主动询问**：「是否需要查看封面图？」——若用户确认需要，**先提示「爬虫爬取封面图时间较长，请稍候」**，再逐个商品抓取封面（见下「QQ Bot 封面图按需查看」）

每行商品按此顺序、用 ` | ` 分隔：

```
| 序号 | 封面 | 商品名称（汉化） | 商家名 | 价格 | 人民币价 | 热度 | 链接 |
```

- **序号位于列表最前方**：从 1 开始递增（1, 2, 3, ...），用于标注排名/顺序

| 字段 | 规则 |
|------|------|
| **序号** | **列表最前方**，从 1 递增，标注排名 |
| **封面** | 商品封面图，位于序号后、商品名前；Markdown 内嵌 `![短名](图片URL)`（booth.pximg.net 原图）；无图用 `—`；QQ Bot 场景省略 |
| **商品名称** | 日文原名，**后接汉化名**：`原名（汉化名）` |
| **商家名** | `shop.name` |
| **价格** | 原价格式（如 `¥5,500`；多档变体用 `¥500~` 起价） |
| **人民币价** | `价格 × 汇率`，格式 `¥233.23` |
| **热度** | 图标+数字：`🔴≥30000` / `🔵10000-29999` / `⚪<10000`，保留收藏数数字（如 `🔴50745`）。**阈值仅适用于 BOOTH 收藏数**——与 vrc-monitor-agent skill 的地图热度阈值（🔴≥100万/🔵≥1万/⚪<1万，按世界访问量）是两套独立分级，勿混用 |
| **链接** | `url`（或 `https://booth.pm/ja/items/{id}`） |

## QQ Bot 封面图按需查看（用户固化要求）

QQ Bot 场景输出无封面列表后，**必须主动询问**是否查看封面图：

> 询问示例：「需要查看封面图吗？爬虫逐个抓取会花较长时间，约 2-5 秒/图，确认后开始」

- 用户**确认**：先提示「爬虫爬取封面图时间较长，请稍候」，再开始逐图抓取（见下流程）
- 用户**拒绝/不需要**：直接结束，不再爬取
- 用户**未明确回复**：视为不需要，结束

**抓取流程**（确认后执行）：

1. **逐个商品取封面**：`images[0].original`（booth.pximg.net 原图），间隔 ~0.4s 防限流；QQ 消息无法渲染外部链接，需**下载图片后上传**（作为 QQ 消息图片/图床发送，而非直接贴 URL）
2. **耗时预期**：每个商品封面下载+上传约 2-5 秒，15 个商品约 30-75 秒——爬取前已向用户预告
3. **失败降级**：某图下载/上传失败，跳过该图继续，不中断整体；全部失败则告知用户「封面图获取失败，可稍后重试」
4. 输出形式：按列表顺序**逐一发送**图片（不拼接），并对应标注商品序号/名称，方便对照

### 汉化规则
- **品牌名/专有名词保留原文**：Kipfel、rurune、Mamehinata、VirtualLens2、PCSS、Chocolat 等
- **通用词汉化**：オリジナル3Dモデル→原创3D模型、システム→系统、ツール→工具、アバター→Avatar/虚拟形象
- **昵称音译**：しなの→信浓、マヌカ→麦卢卡、ミルティナ→米尔蒂娜、ショコラ→巧克力、ルルネ→露露涅、セレスティア→塞莱斯蒂亚、まめひなた→豆日向
- 若用户要求「不汉化」，则省略括号内汉化名

## 卖家后台（登录态，可选）

- 登录入口：`https://booth.pm/users/sign_in`（pixiv 账号体系，**reCAPTCHA Enterprise 防护**——纯脚本无法自动登录，需浏览器手动登录）
- 后台入口：`manage.booth.pm/`（店铺）、`/items`（商品）、`/sales`（收益）、`/orders`（订单）
- 收益管理显示 Total Sales / 领取金额（按订单维度，**不含下载量**）

## 陷阱

1. **curl 发中文会乱码**：git-bash 里 curl 传中文 query 会编码损坏（服务端收到 `????`）——用 Python urllib/requests 发 UTF-8 请求
2. **搜索页空链接**：缩略图 `<a></a>` 块无内容，解析时必须跳过，否则拿到空名称
3. **草稿商品 404**：未发布的商品 `.json` 返回 404，跳过即可
4. **图片防盗链**：booth.pximg.net 图片在部分环境需代理才能加载
5. **限流礼貌**：详情查询间隔 ~0.4s，勿并发轰炸

## 验证

- 工具/脚本跑通后，抽查 2-3 个商品的收藏数与 Booth 页面一致
- 封面图 URL 以 `booth.pximg.net` 开头且可访问
- 人民币换算 = 日元 × 实时汇率（展示汇率来源与日期）
