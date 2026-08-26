# 插件开发指南（PLUGIN-DEV.md）

> 本指南教你如何为一个 **vrchat-assistant** 写一个插件。权威契约见 [PLUGIN-API.md](./PLUGIN-API.md)（v1.1，唯一契约）；本指南是契约的**实践化落地**，示例全部取自仓库真实的官方插件（`plugins/official/`）。
> 目标读者：编写插件的 AI Agent。读完本指南 + 契约，即可写出一个合规插件，无需阅读核心源码。

---

## 1. 一个插件是什么

一个插件 = 一个放在插件目录下的**文件夹**（或单个 `.js` 文件）。保存即生效，无需要重启服务（热加载，见 §7）。

| 放置位置 | 说明 | 是否随主仓管理 |
|----------|------|---------------|
| `plugins/official/<name>/` | 官方插件（随主仓发布） | 是 |
| `plugins/local/<name>/` 或 `plugins/local/<name>.js` | 用户私有插件 | 否（gitignore） |
| `$VRC_MONITOR_PLUGINS_DIR` 指向的目录 | 额外插件位置 | 否 |

**最小形态（单文件）**：`plugins/local/hello.js`——无清单，插件名取文件名，其余约定相同。

**完整形态（推荐）**：

```
plugins/local/hello/
├── plugin.json     # 清单（必需）
├── index.js        # 入口：默认导出 register(api)（必需）
└── schema.sql      # 私有表 DDL（可选，幂等写法，加载时自动执行）
```

仓库 `plugins/official/` 现有 9 个官方插件（events / booth / favorites / groups / media / planet / recommend / world-kb / x-creators），每个都是 `plugin.json + index.js` 两件套，是契约合规的**参考实现**。

---

## 2. plugin.json 清单

```json
{
  "name": "hello",
  "version": "0.1.0",
  "description": "一句话说明这个插件做什么（中文）",
  "author": "你的标识"
}
```

| 字段 | 必需 | 规则 |
|------|------|------|
| `name` | ✅ | 小写字母/数字/中划线，全局唯一；即存储命名空间，用于表前缀 `plg_<name>_` |
| `version` | ✅ | semver |
| `description` | ✅ | 面向 Agent 的一句话 |
| `author` | 否 | |
| `engines.vrc_monitor` | 否 | 如 `">=3.0.0"`，不满足则拒绝加载并说明 |
| `depends` | 否 | 依赖的其他插件名数组，如 `["world-kb"]`；loader 按依赖拓扑排序加载，依赖缺失会拒绝加载并报「请先安装插件 world-kb」 |

清单校验失败（缺 `name`/`version`/`description`、`name` 含非法字符等）的插件会被**拒绝加载**，日志给出具体原因，不影响其他插件。

---

## 3. register(api) 入口

`index.js` 必须**默认导出**一个函数，可同步或返回 Promise：

```js
export default function register(api) {
  api.registerTool({ /* ... */ });
  // 可选：返回清理函数，热卸载/重载时调用
  return function dispose() { /* 清理定时器、句柄等 */ };
}
```

**核心约定：插件代码只准通过 `api` 对象与核心交互。** 禁止 import 核心内部模块、触碰全局 `ctx`、直连数据库文件——见契约 §7 禁止事项与下文 §8。

---

## 4. 6 面 API 用法示例

契约 v1.1 共 6 个 API 表面。以下是每个的用法，示例摘自真实官方插件。

### 4.1 api.registerTool(def) — 注册一个 MCP 工具

定义会进入注册表，出现在 MCP `tools/list`，Agent 可直接调用。**这是插件对外暴露能力的唯一入口。**

```js
api.registerTool({
  name: "hello_greet",                        // snake_case，全局唯一
  description: "向指定名字问好。参数 name：要问候的人名", // 面向 Agent 的中文说明
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "人名" } },
    required: ["name"]
  },
  destructive: false,                          // 可选；true 时安全模式下被自动过滤
  handler: async (args) => {
    return { content: [{ type: "text", text: `你好，${args.name}！` }] };
  }
});
```

要点：
- `name` 冲突：后注册者被拒绝，日志指出冲突双方与所属插件；
- `handler` 抛异常：自动包装为 MCP error 返回，插件与服务不受影响（默认 120s 超时兜底）；
- 返回值默认走 MCP content 结构（`{content:[{type:"text",text}]}`）；
- `destructive: true` 的工具在 `VRC_MONITOR_SAFE_MODE=true` 时不出现在 `tools/list` 且 `tools/call` 同被拦截——与核心工具走同一条 `assertToolAllowed` 路径，插件作者无需额外处理。

### 4.2 api.db — 命名空间存储（显式表句柄）

每个插件拥有自己的表集合，通过**显式表句柄**访问，核心强制加前缀 `plg_<name>_`：

```js
const db = api.db;
const items = db.table("items");   // 实际表名 plg_hello_items，SQL 由句柄层重写
items.run(`INSERT OR REPLACE INTO items (id, note) VALUES (?, ?)`, ["a", "备注"]);
const row = items.get(`SELECT * FROM items WHERE id = ?`, ["a"]);
const rows = items.all(`SELECT * FROM items ORDER BY id`);
db.exec(`CREATE TABLE IF NOT EXISTS ...`);   // 建表也走 db
db.transaction((t) => { for (const x of list) t.run(...); });  // 事务
```

要点：
- 表名只允许出现在 `db.table("...")`；句柄/`db` 都**拒绝**对「非本插件表名」的操作，超出必报可读错误（而非静默查到别的数据）；
- `schema.sql`（若存在）首次加载自动执行；建表语句同样必须经 `db.table()` 声明（或只出现本插件的 `plg_<name>_` 前缀表）；
- **schema 只增不删、版本只升不改**——加列用幂等 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，历史列/表不改名不删；
- 与核心共用同一个 SQLite（WAL），但插件互相不可见、不可跨表。

### 4.3 api.vrchat.fetch(path, options?) — 调用 VRChat REST API

```js
const user = await api.vrchat.fetch("/users/usr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx");
const res  = await api.vrchat.fetch("/worlds/wrld_xxx/favorites",
  { method: "POST", body: { type: "world", favoriteGroup: "worlds1" } });
```

要点：
- 自动携带核心登录态，**插件永远接触不到凭据**；
- 自动走核心限流器（默认 2.6s 间隔），插件无需也不能自行限流；
- 返回解析后的 JSON；非 2xx 抛带状态码的错误；401 由核心统一处理重认证；
- 只准访问 VRChat API 域，外网请求用 Node 自带 fetch（不经此方法）。

### 4.4 api.log(message) — 统一日志

```js
api.log("插件已加载 ✅");
```

自动带插件名前缀与时间戳输出到服务 stdout。**禁止插件自行 `console.log`。**

### 4.5 api.tools.call(name, args) — 调用核心/其他插件的 MCP 工具

完整 MCP 语义的跨插件复用通道：想调核心工具或另一插件暴露的 MCP 工具 → `api.tools.call`；纯逻辑/查询复用优先用 §4.6 的 `provide/consume`。

```js
const info = await api.tools.call("get_world_name", { world_id: "wrld_xxx" });
```

- 工具不存在时抛出带指引的错误（如「工具 x_digest 不存在：对应插件未安装或未加载」），插件自行 catch 并友好降级；
- 参数会经目标工具的 inputSchema 校验，与 MCP 客户端调用同一条路径（含安全模式过滤）；
- 能力探测：`api.tools.has(name)` 判断某工具是否已注册（配合 `depends` 区分「插件没装」vs「版本不兼容」）。

### 4.6 api.provide / api.consume — 插件间轻量服务注册

用于插件之间共享**纯函数/查询逻辑**（不经 MCP 序列化）：

```js
// 提供方
api.provide("query_digest", async (worldId) => { /* ... */ });
// 消费方
const digest = await api.consume("query_digest", "wrld_xxx");
```

- `provide(name, fn)` 注册命名服务；`consume(name, ...args)` 同步/异步调用；返回值是**原生结构**（不包装 message）；
- 服务名全局唯一：同名跨插件冲突以后注册者被拒并告警（与 registerTool 冲突策略一致）；插件只能 `consume` 已被 `provide` 的命名空间（依赖拓扑保证提供方先加载）；
- 能力探测：`api.hasService(name)` 查询某服务是否已提供；
- **职责划分**：共享「查询/逻辑」→ `provide/consume`；共享「能力但需要完整 MCP 语义或参数校验」→ `api.tools.call`。**对外暴露给客户端的工具，永远用 `registerTool`。**

---

## 5. 数据与核心服务：插件工具不碰 ctx

插件工具**不持有 `ctx`**，也不直接读核心表；需要核心能力/数据时走三种通道：

1. **核心服务（consume）**——`start-monitor.js` 的 `registerCoreServices()` 把一组核心服务暴露到共享服务注册表，插件用 `api.consume("<域>.<名>", args)` 消费。现有服务组：
   - `storage.<method>`：核心存储方法白名单（如 `storage.getWorldName` / `storage.upsertWorld` / `storage.getBoothItemCache` / `storage.listBoothItems` / `storage.getZhTranslations` 等）；
   - `x.<name>`：X 博主世界推荐（`x.creators` / `x.addCreator` / `x.scanCreators` / `x.worldDigest` …）；
   - `world.<name>`：世界知识库（`world.scanNewWorlds` / `world.getNewWorlds` / `world.rateWorld` / `world.addToBacklog` …）；
   - `recommend.<name>`：推荐引擎（`recommend.favoriteFriendsLocations` / `recommend.recommendJoin` / `recommend.recommendWorlds` …）。
2. **api.vrchat.fetch**——需要调 VRChat REST 时（见 §4.3）。
3. **api.tools.call**——需要完整 MCP 语义地调另一个工具时（见 §4.5）。

**典型模式**：插件只做「定义工具 + 把参数转交核心服务」，自身不存业务逻辑。例如 `plugins/official/world-kb/index.js`：

```js
api.registerTool({
  name: "get_new_worlds",
  description: "[query] 查询已收录的新世界（只读）。",
  inputSchema: { type: "object", properties: { limit: { type: "number", default: 10 } } },
  handler: async (args) => api.consume("world.getNewWorlds", args)
});
```

需要自有表时，插件用 `api.db` 建自己的 `plg_<name>_` 表，与核心表完全隔离。示例：`plugins/official/booth/index.js` 用 `api.consume("storage.recordBoothSearch", ...)` / `api.consume("storage.getBoothSearches", ...)` 落库查询。

---

## 6. 命名与约束速查

| 项 | 约束 |
|----|------|
| 插件名 | 小写字母/数字/中划线，全局唯一；即存储命名空间 |
| 工具名 | snake_case，全局唯一（核心与所有插件统一命名空间） |
| 表别名 | 经 `api.db.table()` 声明，实际表 `plg_<name>_<alias>` |
| 工具前缀 | 建议 `hello_`，便于辨识来源；破坏性工具（`remove_`/`delete_`/`leave_`/`decline_`/`hide_`/`unfavorite_`/`unfriend_` 等）必须声明 `destructive: true` |
| 依赖 | `depends` 声明依赖插件名；拓扑排序加载；依赖缺失/成环拒绝加载 |

**零依赖约定**：v1 插件只准使用 Node ≥22 内置模块（含全局 fetch）。确需第三方包属进阶场景，需在清单声明 `dependencies` 并自带安装说明——主仓官方插件一律零依赖。

---

## 7. 加载 / 热加载 / 失败隔离

- **加载**：服务启动时扫描全部插件目录 → 校验清单（含 `depends` 拓扑排序：被依赖者先加载；依赖缺失 → 拒绝加载并指引；依赖环 → 拒绝加载并报环）→ 执行 `schema.sql` → 调用 `register(api)`（Promise 则 await）。加载失败只禁用该插件，日志给出修复指引，服务与其他插件正常。
- **热加载**：watch 插件目录。新增插件 → 自动加载；文件变更 → 先调旧版 `dispose()`、注销其全部工具，再加载新版（新版加载失败则回滚旧版并告警）；删除插件 → 调 `dispose()` 并注销其工具。**热加载后既有 WebSocket 连接与进行中的调用不中断。**
- **状态清理**：插件启动的定时器/句柄必须在 `dispose()` 中清理；不重载期间内存状态自行负责（崩溃不传染，但同插件状态随重载丢失——持久化请用 `api.db`）。
- **状态可见**：`/health` 返回 `plugins` 段：每个插件的 name/version/status/error/已应用 schema 版本，便于诊断「改了没生效」。

---

## 8. 禁止事项（loader 静态扫描 + 运行时防护）

1. 禁止 `import` 任何 `core/` 路径、`start-monitor.js`；禁止动态 `import()` 非插件自身文件；
2. 禁止读取含 `KEY`/`SECRET`/`TOKEN`/`PASSWORD`/`COOKIE`/`AUTH`（忽略大小写）的环境变量与仓库根目录此类配置文件；允许读取 `VRC_MONITOR_*` 公共配置（排除上述敏感项）；
3. 禁止读写数据库文件本体（`data/vrc-monitor.sqlite3*`）；一切持久化走 `api.db`；
4. 禁止访问凭据加密存储、核心 `secure_secrets`（或等价）表、任何主密钥解密接口；
5. 禁止 `child_process`；
6. 禁止 `process.exit` / 未捕获的顶层副作用：插件代码必须在 `register()` 内执行，import 时不得有副作用（热加载依赖此保证）。

**loader 静态扫描**会检测 `readFileSync`/`createReadStream`/`openSync`/`readFile` 等调用命中敏感文件（`credentials.json`/`auth_cookie.txt`/加密存储等）或受禁 env；工具名匹配破坏性前缀但未声明 `destructive: true` → 拒绝加载并提示。违反 1-5 会被拒绝加载并明示原因；违反 6 属编码错误，表现为热加载异常。

---

## 9. 完整示例（可直接照抄改写）

`plugins/local/hello/plugin.json`：
```json
{ "name": "hello", "version": "0.1.0", "description": "示例：打招呼 + 记录见过的人" }
```

`plugins/local/hello/schema.sql`：
```sql
CREATE TABLE IF NOT EXISTS seen (name TEXT PRIMARY KEY, seen_at TEXT DEFAULT (datetime('now')));
```

`plugins/local/hello/index.js`：
```js
export default function register(api) {
  api.registerTool({
    name: "hello_greet",
    description: "向某人问好并记录。参数 name：人名",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "人名" } },
      required: ["name"]
    },
    handler: async (args) => {
      api.db.table("seen").run("INSERT OR REPLACE INTO seen (name) VALUES (?)", [args.name]);
      api.log(`已问候 ${args.name}`);
      return { content: [{ type: "text", text: `你好，${args.name}！` }] };
    }
  });

  api.registerTool({
    name: "hello_seen_list",
    description: "列出所有问候过的人",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const rows = api.db.table("seen").all("SELECT name, seen_at FROM seen ORDER BY seen_at DESC");
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }
  });

  api.provide("hello_digest", async (name) => `近期问候：${name}`);
  return function dispose() {};
}
```

---

## 10. 版本与兼容承诺

- 契约当前处于 **experimental 阶段**：`api.provide/consume` 等新 API 在达到冻结门槛（至少 10 个社区插件实践 / 一个发布周期）前**允许修改或移除**；冻结后转为「只增不改」。
- 契约随核心 `package.json` major 版本走；冻结后 v1 期间只新增 API（如计划中的 `api.events`、`api.config`），不修改既有行为。
- **官方插件是契约合规的参考实现**：疑问先看 `plugins/official/`，契约细节以 [docs/PLUGIN-API.md](./PLUGIN-API.md) 为准。
