# 无构建工具时的前端模块化（大单文件前端拆分）

> 单插件 + 路由器/NAS/Docker 部署、无 node_modules、无构建工具的约束下，把 50KB+ 的单文件前端（HTML 内联 CSS/JS）安全拆成多文件的已验证配方。2026-08-26 在 vrchat-assistant 的 web-dashboard 插件实际跑通。

## 为什么不能手写解析器

超大单行 JS 里函数多为 **`const 箭头函数`**（`const esc=s=>...`）而非 `function` 声明，且模板字符串嵌套 `${}`（表达式里又有引号/嵌套模板），**手写 tokenizer/正则按 `;` 或 `}` 切分必然失败**（本会话实测：按 `;` 切分把模板串内容误判为普通代码、按函数边界切分漏掉箭头函数）。解法：开发期临时装 `acorn`（纯 JS 解析器，无原生依赖），用其 AST 的 `node.start/end` 精确切分——acorn 已经正确解析了所有字符串/模板/注释边界。

## 资产注入模式（零运行时依赖）

浏览器端仍是**单个普通 `<script>` 块**（不用 `type="module"`，避免 CORS/加载时机变化）：

1. HTML 骨架里留占位符：`<script>__DASHBOARD_JS__</script>`、`<style>__DASHBOARD_CSS__</style>`。
2. 插件入口 `register()` **模块顶层**（加载时一次）读资源拼接注入：
   ```js
   const indexHtml = readFileSync(path.join(__dirname,'dashboard.html'),'utf8')
     .replaceAll('__DASHBOARD_CSS__', readFileSync(path.join(__dirname,'client','dashboard.css'),'utf8'))
     .replaceAll('__DASHBOARD_JS__',
       readFileSync(...,'util.js') + '\n' + readFileSync(...,'views.js') + '\n' + readFileSync(...,'app.js'));
   ```
3. **多个同名占位符必须用 `.replaceAll()`**：`.replace()` 只替换第一个，第二个会原样残留成页面上的裸文本（本会话踩坑：两个 `<style>` 块替换成同一占位符后只换了一个）。
4. 多 JS 文件按 `util → views → app` 顺序拼进同一 `<script>`：共享作用域，`function` 声明提升 + `const` 的 TDZ 都不构成问题（顶层执行语句都在 `app.js` 尾部，运行时所有 const 已初始化）。
5. 浏览器行为与拆分前完全一致：没有新增静态路由、没有改鉴权、没有改访问方式。

## acorn 拆分流程

```bash
# 开发期一次性（部署不需要 acorn）
mkdir -p /tmp/jsx && cd /tmp/jsx && npm install acorn --no-save
```

脚本要点（`import {parse} from '.../acorn/dist/acorn.js'`）：
- `parse(src, {ecmaVersion:2022, sourceType:'script'})`，遍历 `ast.body`。
- 收集顶层函数声明：`VariableDeclaration`（单声明 + `init` 为 `ArrowFunctionExpression`/`FunctionExpression`）**和** `FunctionDeclaration` 都要（名字名单驱动，两种形态都匹配）。
- 用 `node.start/node.end` 取精确源码片段，按原顺序拼接成目标文件；从源文件**从后往前**删除。
- 需要依赖审计时，写 walker 时**务必跳过 `MemberExpression.property`（非 computed）、对象 `Property.key`（非 computed）、带默认值的参数（`AssignmentPattern.left`）**——否则方法名（`.replace`）、对象属性名、参数名全被误报成外部依赖（本会话第一版就全误报，修正 walker 后为零）。

## 等价验证（每步必做）

1. 拼接后 `node --check`（语法）。
2. **重新 parse 对比**：`util+views+app` 拼接结果的 `ast.body.length` 与拆分前基准（`util + 拆分前app`）**相等**，且顶层声明名集合**零差异**（`only in base` / `only in now` 均为空）。
3. 本地模拟完整注入（readFileSync 同一逻辑）后，提取 `<script>` 块 `node --check`；确认占位符归零。
4. 部署到容器后，容器内 fetch `/dashboard` 提取 script `node --check` + 断言关键函数名存在（`loadHome`/`render`/`startSse`/`trustBadge`…）+ 各 API 端点 200。

## 前端资源重构后“前端没反应”的分诊

用户报“前端几乎都没有反应”（页面加载了但点击无响应）时，先按顺序：
1. 本地复现注入逻辑，确认最终 HTML 的 `<script>`/`<style>` 结构与占位符归零（排除注入把 HTML 切坏）。
2. 容器内 fetch 页面提取 JS `node --check`（排除部署的文件缺失/旧版）。
3. 若以上都正常 → **几乎都是浏览器缓存旧版**，让用户 Ctrl+F5 强刷；后端接口探针 200 佐证服务本身健康。
本会话即此场景：强刷后恢复，无需回滚。
