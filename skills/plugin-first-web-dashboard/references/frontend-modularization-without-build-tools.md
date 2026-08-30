# 无构建工具的前端模块化（Dashboard 实战验证）

> 在 headless Node 服务 + Docker 部署、无前端构建工具 / 无 npm 运行时依赖的前提下，把一个 47KB 单行压缩的 `<script>` 前端按职责拆成多文件，并保证行为零变化。

## 为什么不能靠正则/字符串切割

`dashboard.html` 曾含 ~50KB 内联 CSS + ~47KB 内联 JS（每行一个或多个超长函数）。直接物理切割风险高：
- 前端"函数"是 **const 箭头函数 + function 声明 + 函数表达式**混合，按 `function` 关键字提取会漏掉大量箭头函数（`const esc=s=>...` 根本没有 `function`）
- 模板字符串嵌套复杂（`${...}` 里还有引号/嵌套反引号），自制 tokenizer 状态会错乱，切出来的片段是半个模板字符串 → 语法错误或静默行为变化
- 按顶层 `;` 切分也不可靠：模板内嵌表达式里的 `;` 会被误判

## 可靠方法：acorn AST 提取 + 拼接注入

acorn 是纯 JS 解析器，只作**开发期一次性工具**（`npm install acorn --no-save`，部署不需要），用 `node.start`/`node.end` 精确切割，绝不切开模板字符串。

步骤：
1. `npm install acorn --no-save`（临时目录），`import { parse } from 'acorn'`
2. `parse(src, { ecmaVersion: 2022, sourceType: 'script' })`，遍历 `ast.body` 收集顶层函数声明：
   - `VariableDeclaration`（单声明且 `init` 是 ArrowFunctionExpression/FunctionExpression）→ 箭头/表达式函数
   - `FunctionDeclaration` → 函数声明
3. 按名单筛选要拆出的函数，`src.slice(node.start, node.end)` 精确提取（每条是完整顶层语句，含结尾 `;`）
4. 从原文件**逆序删除**（按 `start` 降序 `rest = rest.slice(0,d.start)+rest.slice(d.end)`，避免位移）
5. 后端注入时把多个 JS 文件**拼接进同一个 `<script>` 块**（共享作用域），顺序 `util → views → app`——函数声明提升 + const 引用在运行时解析，交叉引用可用；**末尾执行语句**（`load()` 等）必须在所有 const 定义之后（app.js 内保持原顺序即可）

依赖审计（可选但推荐）：对提取的每个函数体重新 `parse` 统计自由标识符，过滤：内置全局、名单内函数、对象属性/方法名误报（MemberExpression 只统计 `object`，非 computed 的 `property` 不计；对象字面量非 computed 的 key 不计；带默认值参数 `cls='avatar'` 是 AssignmentPattern，要取 `left`）。

## 等价性验证（每次必做）

- 拼接后 `node --check` 必须通过
- 用 acorn 分别 parse「util + 拆分前」与「util + views + app」，对比 `ast.body.length` 与顶层声明名集合，**必须完全一致**（注意基准要对：拆分前文件本身不含已拆出的 util 层）
- 容器内：fetch `/dashboard` 提取 `<script>` 内容，`node --check`，再检查关键函数存在（`code.includes('function loadHome')` 等）

## 其他前端资源抽取

- CSS / JS 都写成 `client/` 下的独立文件，HTML 留 `__DASHBOARD_CSS__` / `__DASHBOARD_JS__` 占位，后端 `readFileSync(...).replaceAll('占位', 内容)` 注入
- **用 `replaceAll`**：HTML 里若有两个占位符实例，`.replace()` 只替换第一个，第二个会原样漏到页面
- 注入内容里不能含 `</script>` 字面量（会提前闭合 script 块）——CSS/JS 一般没有，但改完后检查一次

## 视图切换竞态修复（viewToken 模式）

问题：每个视图 `loadXxx()` 异步 await，快速切换后**旧请求完成时无条件渲染**，覆盖新视图 / 把用户"跳回"上一页。

修复：
- `app.js`：`let viewToken=0;`，`render()` 开头 `const token=++viewToken;`，所有 `loadXxx()` 调用改 `loadXxx(token)`
- 每个视图 load 签名加 `token`，**每个 `await get(...)` 之后**（渲染前）插 `if(token!==viewToken)return;` 丢弃过期请求
- 陷阱：guard 必须带尾分号 `...return;`（`return` 后直接接语句会拼成 `returnconst` 语法错）

## 慢接口缓存 TTL 调优

慢接口根因是 VRChat **限流 API 串行排队**（每个请求 ~2.6s）：
- 收藏世界 ~7s（`get_my_favorite_worlds` 逐个查世界详情）、我的模型 ~7.8s（auth/user+avatars+favorites 三个限流请求）、屏蔽管理 ~5s（blocked+muted）、通知 ~2.6s
- 缓存 TTL 按"数据变化频率"定：收藏世界 30min、模型/屏蔽/收藏好友 10min、首页收藏位置 5min
- 实测命中缓存：`moderation` 2943ms → 5ms（~580 倍）
- **不做激进后台预热**：`get_my_favorite_worlds` 逐个查 ~60 个世界 × 限流 ≈ 150s，会占满限流队列拖慢主流程；靠长 TTL 即可

## 部署验证模式（每次改前端后）

容器内 fetch `/dashboard` → 提取 `<script>` → `node --check` → 检查关键函数注入 → 探测接口 200（带耗时）→ `docker inspect` healthy。改完前端**务必告知用户强刷（Ctrl+F5）**——浏览器缓存旧 HTML 会表现为"前端没反应"，强刷即恢复，不是代码回归。
