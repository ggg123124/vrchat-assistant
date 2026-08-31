# Dashboard 前端：竞态 token 无参调用 bug + 单行压缩 JS 编辑陷阱

> 触发：Dashboard 页面"切 tab/过滤后卡在加载中"、"切回某视图卡半天"；或批量编辑 views.js 后出现语法错误/重复段。
> 本会话真实事故两次：① 收藏页切回卡半天 ② python 批量替换把 views.js 改坏。

## Bug 模式：竞态保护 + onclick 无参调用 = 永远不渲染

模块化后每个视图加载函数带竞态 token：`async function loadXxx(token){ ...; if(token!==viewToken)return; ...渲染... }`（`viewToken` 是全局计数，`render()` 每次 `++viewToken`）。

**坑**：视图内部 tab/过滤切换的 onclick 写成 `loadXxx()`（无参）→ token 为 `''`/undefined → `'' !== 数字` 恒真 → **直接 return 不渲染**，界面停在"加载中…"（用户感知"卡半天/卡死"）。侧栏进入走 `render()` 传了 token，所以"从左侧栏进来正常"——两者对照正是这个 bug 的指纹。

**修复**：所有内部切换调用统一 `loadXxx(viewToken)`（viewToken 是全局，可读）。本会话一次修了 4 个函数：`loadFavorites`（favType/favWorldMode/favGroup 切换）、`loadNotifications`（notificationType 过滤）、`loadSearch`（searchType）、`loadStats`（statsDays）。

**审计手法**：`re.finditer(r'onclick=\(\)=>\{[^}]*?([a-zA-Z]+)\(\)\}', views.js)` 找所有无参调用，逐一核对函数签名是否带 token。

## 陷阱：views.js 是"每函数一行"的压缩风格，别用 python 字符串批量替换

`views.js` 把 37+ 个函数各压成**一行超长行**（单行数千字符）。对这种文件：

- python `str.replace` / 正则**跨函数替换极易产生重复段 + 语法错误**（本会话真实事故：loadFavorites 的 worlds 渲染段重复 6 份、`try{body..innerHTML` 双点、函数尾部拼接错乱，lint 报 `Missing catch or finally after try`）。
- 优先用 `patch` 工具（精确 old_string + 唯一性检查），不要整文件 python replace。
- 若已损坏：定位函数边界（`find('async function loadFavorites')` → `find('function profileHeader', i)`），用**干净版本整函数替换**那段（不是继续小修小补）。
- 每次大改后立刻 `node --check`（拼接 util+views+app 后 check）验证语法，别等到部署才发现。
- 删某个 tab/分支后 grep 残留（如 `data-fav-type`、`收藏 Avatar`）确认无孤儿绑定；确认被删的 DOM 容器（如 `#favBody`）仍被创建，否则 `querySelector(...)` 为 null 崩溃。

## 用户偏好（UI 简化方向）

- 能按"收藏夹/分组"显示的独立页（收藏分组、收藏 Avatar tab）会被要求删除，避免重复入口（"我的模型"页已有收藏模型）。改这类页面先问/确认重复入口再动手。
- 收藏页最终形态：直接显示收藏世界（按类别 / 按收藏夹 worlds1-4 切换），无顶层 tab。
