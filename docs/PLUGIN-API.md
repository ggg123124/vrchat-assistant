# PLUGIN-API.md — vrchat-assistant 插件契约（v1-experimental）

> 本文档是插件与核心之间的**唯一契约**。
> **冻结规则**：当前处于 **experimental 阶段**——达到冻结门槛（**至少 10 个社区插件实践 / 一个发布周期**）之前，新增/微调 API 行为属预期，不做"只增不改"承诺；达到门槛后转为**只增不改**。契约变更在本文档顶部 Changelog 记录。
> 目标读者：编写插件的 AI Agent。读完本文即可写出一个合规插件，无需阅读核心源码。

## 0. 设计目标（优先级从高到低）

1. **开发门槛极低**：完全不懂计算机的使用者，其 Agent 只需在 `plugins/` 下创建一个文件夹即可完成新功能；不修改核心文件、不需要 git、不需要 npm install、不需要重启服务。
2. **核心停止腐化**：核心只保留认证/采集/存储/传输底座，功能代码以插件形式存在，中央注册表消亡。
3. **行为完全兼容**：92 个现有工具的名称、参数、返回结构不变；存量数据库无损；MCP 客户端（Hermes 等）无感知。
4. **故障隔离**：任何插件加载或运行失败，不影响监控主链路（WS 采集、事件落库）与其他插件。**明确为"逻辑隔离"**——插件异常/加载失败/注册冲突不传染、不污染注册表、不影响核心与其他插件；**但不承诺** CPU/内存/EventLoop 资源隔离（见 §4.1）。

## 1. 插件是什么

一个插件 = 一个文件夹（或单个 `.js` 文件），放在插件目录下即被自动加载：

| 目录 | 用途 | 是否随主仓管理 |
|------|------|---------------|
| `plugins/official/<name>/` | 官方插件 | 是 |
| `plugins/local/<name>/` 或 `plugins/local/<name>.js` | 用户私有插件 | 否（已 gitignore） |
| `VRC_MONITOR_PLUGINS_DIR` 环境变量指向的目录 | 额外插件位置 | 否 |

**保存即生效**：核心 watch 插件目录，新增/修改/删除插件无需重启服务（热加载，见 §5）。

### 目录形态（完整插件）

```
plugins/local/hello/
├── plugin.json     # 清单（必需）
├── index.js        # 入口：默认导出 register(api)（必需）
└── schema.sql      # 私有表 DDL（可选，幂等写法，加载时自动执行）
```

### 单文件形态（极简插件）

`plugins/local/hello.js`：无清单，插件名取文件名，其余约定相同。

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
| `name` | ✅ | 小写字母/数字/中划线，全局唯一；即存储命名空间，用于表名前缀 `plg_<name>_` |
| `version` | ✅ | semver |
| `description` | ✅ | 面向 Agent 的一句话 |
| `author` | 否 | |
| `engines.vrc_monitor` | 否 | 如 `">=3.0.0"`，不满足则拒绝加载并说明 |
| `depends` | 否 | 依赖的其他插件名数组，如 `["world-kb"]`。loader 按依赖拓扑排序加载；依赖缺失时拒绝加载并报错「请先安装插件 world-kb」。**不设硬版本约束**（过度设计），但提供能力探测：`api.tools.has(name)` / `api.hasService(name)`（§4.6），调用方 catch 错误时能区分「插件没装」vs「装了但版本不兼容/能力缺失」——不兼容时返回带指引的错误而非静默失败。**加载期依赖环**（A depends B 且 B depends A）会被检测，拒绝加载并报环（明示成环插件名），不进入加载。运行时"调用环"不属此类（运行时无锁定、不死锁），但设计上避免互相递归 |

> **dependencies 不在 plugin.json 里声明**：插件第三方依赖统一走插件目录内自带 `package.json`（见 §6.1）。

**清单校验失败的插件被拒绝加载，日志给出具体原因（不影响其他插件）。**

## 3. register(api) 入口

`index.js` 必须默认导出一个函数，可同步或返回 Promise：

```js
export default function register(api) {
  api.registerTool({ /* ... */ });
  // 可选：返回清理函数，热卸载/重载时调用
  return function dispose() { /* 清理定时器、句柄等 */ };
}
```

插件代码只准通过 `api` 对象与核心交互。**禁止** import 核心内部模块、触碰 `ctx`、直连数据库文件——见 §7 禁止事项。

## 4. API 表面（v1-experimental 共 7 个）

### 4.1 api.registerTool(def) — 注册一个 MCP 工具

```js
api.registerTool({
  name: "hello_greet",                      // snake_case，全局唯一
  description: "向指定名字问好。参数 name：要问候的人名",  // 面向 Agent 的中文说明
  inputSchema: {                            // JSON Schema（MCP 标准）
    type: "object",
    properties: { name: { type: "string", description: "人名" } },
    required: ["name"]
  },
  destructive: false,                       // 可选。true 时安全模式下被自动过滤
  handler: async (args) => {
    return { content: [{ type: "text", text: `你好，${args.name}！` }] };
  }
});
```

规则：
- `name` 冲突：后注册者被拒绝，日志指出冲突双方与所属插件；
- `handler` 抛异常：自动包装为 MCP error 返回给调用方，插件与服务不受影响；调用默认 120s 超时兜底；
- 返回值默认走 MCP content 结构（`{content:[{type:"text",text}]}`）；**预留扩展位**——允许返回 `image`/`resource` 类型 content 及 `outputSchema` 字段（符合冻结规则；v1 以 text 为主，结构化/资源返回后续版本开放）。`registerTool` 定义含可选 `outputSchema` 字段说明（仅声明，不实现约束）；
- `destructive: true` 的工具在 `VRC_MONITOR_SAFE_MODE=true` 时不出现在 tools/list，且 tools/call 同被拦截——与核心工具走同一条 `assertToolAllowed` 路径，插件工具**不绕过**安全模式。插件作者无需额外处理；
- **resource 隔离说明**：第 4 点 + 设计目标 #4 仅指**逻辑隔离**（异常/加载失败/注册冲突不传染、不污染注册表、不影响核心与其他插件），**不承诺** CPU/内存/EventLoop 资源隔离。同步阻塞（死循环、同步大文件读写）不受 `120s 超时` 保护，可能拖垮主链路——v1 诚实说明，后续路径预留 worker_thread 隔离层（不在 v1 实现）。使用者对「插件放进来安全吗」的预期以此为准。

### 4.2 api.db — 命名空间存储（显式表句柄）

每个插件拥有自己的表集合，通过**显式表句柄**访问，核心强制加前缀 `plg_<name>_`（`name` 为清单名）：

```js
const db = api.db;
const items = db.table("items");               // 实际表名 plg_hello_items，SQL 由句柄层重写
const seen  = db.table("seen");
db.exec(`CREATE TABLE IF NOT EXISTS ...`);     // 建表也走句柄，见下
items.run(`INSERT OR REPLACE INTO items (id, note) VALUES (?, ?)`, ["a", "备注"]);
const row = items.get(`SELECT * FROM items WHERE id = ?`, ["a"]);
const rows = items.all(`SELECT 1, 2, 3`);       // 列/字面量原样，句柄只处理 FROM 的表名
db.transaction((t) => { for (const x of list) t.run(...); });  // 事务
```

- **表名只允许出现在 `db.table("...")`**：返回的句柄对象（`.run/.get/.all/.exec/.transaction`）在其 SQL 内对 `items` 这类裸表名做单点重写（只改 FROM/INSERT INTO 等表上下文，列名/别名/字面量/CTE 不碰——因为用户手里的句柄就是命名空间锚点，重写范围自然收窄）；句柄/`db` 均**拒绝**对「非本插件表名」的操作，超出必报可读错误（而非静默查到别的数据）；
- `schema.sql`（若存在）在插件首次加载时自动执行；**建表语句同样必须经 `db.table()` 声明的表名**（或由 loader 校验 schema.sql 只出现本插件的 `plg_<name>_` 前缀表），其余表名拒绝并给出报错；
- **schema 版本约定（v1 简化）**：插件 schema **只增不删、版本只升不改**——加列用幂等 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（SQLite 3.35+），历史列/表不改名不删，杜绝「半迁移」脏状态；
- 与核心共用同一个 SQLite（WAL），但插件互相不可见、不可跨表。

### 4.3 api.vrchat.fetch(path, options?) — 调用 VRChat REST API

```js
const user = await api.vrchat.fetch("/users/usr_c1644b5b-3ca4-45b4-97c6-a2a0de70d469");
const res  = await api.vrchat.fetch("/worlds/wrld_xxx/favorites", { method: "POST", body: { type: "world", favoriteGroup: "worlds1" } });
```

- 自动携带核心登录态（cookie/auth header），**插件永远接触不到凭据**（凭据由核心加密存储、入库管理，无明文文件，见 §7）；
- 自动走核心限流器（默认 2.6s 间隔），插件无需也不能自行限流；
- 返回解析后的 JSON；非 2xx 抛出带状态码的错误；401 由核心统一处理重认证；
- 只准访问 VRChat API 域，外网请求请用 Node 自带 fetch（不经过本方法，见 §7 网络约定）。
- **凭据不可达声明**：经 `api.vrchat.fetch` 调用时插件对凭据无感知（由核心统一注入）；凭据本体已加密入核心表、无明文文件，插件无法读取明文。但插件**本体拥有宿主进程的文件/网络能力**，因此「凭据不可达」依赖 §7 的静态/运行时防护与信任模型。v1 明确：**仅安装可信插件；社区索引插件须经审核方可收录**。

### 4.4 api.log(message) — 统一日志

```js
api.log("插件已加载 ✅");
```

自动带插件名前缀与时间戳，输出到服务 stdout（容器友好）。禁止插件自行 console.log。

### 4.5 api.tools.call(name, args) — 调用核心/其他插件的 MCP 工具

```js
// 推荐插件查询核心维护的世界知识库，而不是自己碰表
const info = await api.tools.call("get_world_name", { world_id: "wrld_xxx" });
```

- 这是插件间**复用能力的通道之一**（完整 MCP 语义场景）：想调核心工具或另一个插件暴露的 MCP 工具 → `api.tools.call`；纯逻辑/查询复用优先用 §4.6 `provide/consume`；
- 工具不存在时抛出带指引的错误（如「工具 x_digest 不存在：对应插件未安装或未加载」），插件应自行 catch 并友好降级；
- 参数会经过目标工具的 inputSchema 校验，与 MCP 客户端调用同一条路径（含安全模式过滤）；
- 循环依赖（A 调 B、B 调 A）不会死锁——调用走注册表分发，无加载期锁定；但请在设计上避免运行时互相递归调用。

### 4.6 api.provide / api.consume — 插件间轻量服务注册

用于插件之间共享**纯函数/查询逻辑**（不经 MCP 序列化）：

```js
// 提供方
api.provide("query_digest", async (worldId) => { /* ... */ });
// 消费方
const digest = await api.consume("query_digest", wrld_xxx);
```

- `provide(name, fn)` 注册一个命名服务；`consume(name, ...args)` 同步/异步调用。
- 服务名全局唯一：同一插件重复 provide 覆盖；跨插件同名冲突以后注册者被拒并告警（与 registerTool 冲突策略一致）。
- 返回值**原生结构**（不包装 message），适合内部复用；**不经过**安全模式过滤与 inputSchema 校验（那是给 MCP 客户端入口用的）。
- 插件只能 `consume` 已被 `provide` 的命名空间；依赖拓扑排序保证 `provide` 方先加载（见 §2 `depends`）。
- **职责划分**：共享「查询/逻辑」→ `provide/consume`；共享「能力但需要完整 MCP 语义或参数校验」→ `api.tools.call`（§4.5）。**对外暴露给客户端的工具，永远用 `registerTool`，不因 provide/consume 而绕过**。
- 能力探测：`api.hasService(name)` 查询某服务是否已提供（配合 §2 区分「插件没装」vs「版本不兼容」）。

### 4.7 api.health(obj) — 运行态上报（并入 `/health`）

```js
export default function register(api) {
  api.health({ dashboardUi: { state: 'built' } });
  // → GET /health 的 extras.<pluginName>.dashboardUi
}
```

- **用途**：把插件自身的运行态（就绪/降级/缺失等）暴露给运维与 Agent 诊断，无需自建端点。
- **键空间隔离**：上报内容按 **插件名** 收纳在 `/health` 的 `extras` 段（`extras: { <pluginName>: {...} }`），**不参与核心字段命名空间**——插件无法覆盖 `auth`/`plugins`/`ws` 等核心字段（避免误报认证状态等语义破坏）。
- **清理**：**卸载、热重载，以及加载/重载失败**（register 抛错、失败回滚）时，loader 均自动清除该插件的 `extras` 键（与路由/服务/工具同路径），无需在 `dispose()` 中手工清理。失败路径同样清理——避免 `/health` 为未加载的插件签名、或为已回滚的插件报错版本状态。
- **兼容**：旧核心（无此 API 面）下应做能力探测（`typeof api.health === 'function'`）后再调用，否则插件加载会因 `api.health is not a function` 失败。

## 5. 生命周期与热加载

1. **加载**：服务启动时扫描全部插件目录 → 校验清单（含 `depends` 拓扑排序：被依赖者优先加载；依赖缺失 → 拒绝加载该插件并报错指引；依赖环 → 拒绝加载并报环）→ 执行 schema.sql → 调用 `register(api)`（若是 Promise 则 await）。加载失败（语法错误/校验失败/注册冲突）只禁用该插件，日志给出修复指引，服务与其他插件正常。
2. **热加载**：watch 插件目录。新增插件 → 自动加载；文件变更 → 先调旧版 `dispose()`、注销其全部工具，再加载新版（新版加载失败则回滚旧版并告警；**回滚同时还原旧版的路由与 `/health` 上报快照**，失败新版的工具/路由/上报/服务占用全部释放）；删除插件 → 调 `dispose()` 并注销其工具。**热加载后既有 WebSocket 连接与进行中的调用不中断**（PR-2 验收用例）。
3. **状态清理**：插件启动的定时器/句柄必须在 `dispose()` 中清理；不重载期间插件内存状态自行负责（崩溃不会传染其他插件，但同插件状态随重载丢失——持久化请用 api.db）。
4. **状态可见**：`/health` 返回 `plugins` 段：每个插件的 name/version/status/error/**已应用 schema 版本**，便于 Agent 诊断与线上排查「改了没生效」类问题。

## 6. 插件可以做什么 / 不可以做什么

| 可以 | 不可以（§7 详述） |
|------|------------------|
| 注册任意数量 MCP 工具 | import 核心内部模块、触碰全局 ctx |
| 用 api.db 建自己的表 | 访问其他插件/核心的表 |
| 用 api.vrchat.fetch 调 VRChat API | 读取凭据（凭据已入库加密，插件不可达） |
| 用 Node 内置模块 + fetch 访问外网 | 官方插件可经插件自带 package.json 声明第三方依赖（见 §6.1）；local 插件同样适用 |
| 读取插件目录内自己的文件 | 写插件目录以外的文件（数据走 api.db） |

**依赖约定**：插件默认只准使用 Node ≥22 内置模块（含全局 fetch），保证「拷贝文件夹即用」。确需第三方包走插件自带 `package.json` 声明（见 §6.1），不要求在 plugin.json 里声明。

### 6.1 第三方依赖（插件自带 package.json）

1. **声明位置**：插件目录内 `package.json` 的 `dependencies`；`"private": true`；`"type": "module"` 与仓库 ESM 一致；包名用 `vrc-monitor-plugin-<插件名>` 避免撞 npm 公仓。plugin.json 不重复声明 dependencies（唯一权威源是插件目录 package.json，杜绝两处漂移）。
2. **提交物**：`package.json` 与 `package-lock.json` 都提交进 git（lock 保证各平台可复现、CI 可 `npm ci`）；`node_modules/` 已被根 .gitignore 任意深度忽略，不提交。
3. **安装**：clone/pull 后在仓库根执行 `npm ci --prefix plugins/official/<name>`（或 `npm run install-plugins` 逐插件探测并 npm ci）。跨平台一致（Win/Linux/mac/NAS/容器）。
4. **loader 探测**：加载插件前若无依赖可 resolve（`createRequire(插件package.json).resolve(dep)`），则**拒绝加载该插件**（不影响其他插件与主链路），日志与 `/health` plugins 段给出指引：`插件 <name> 缺少依赖 <dep>，请在仓库根执行: npm ci --prefix plugins/official/<name>`。
5. **loader 绝不自动 npm install**：保持加载路径无副作用、无 child_process、热加载快；缺依赖只拒载 + 指引。
6. **官方插件依赖准入规则**：每个依赖须纯 JS 优先；确需原生模块须在 PR 说明 prebuilt 对各目标平台（含 ARM NAS、Alpine/musl）的覆盖（DEVELOPMENT.md §3.3 原文继续适用并在此引用）；依赖须 MIT/BSD/Apache-2.0 等兼容许可；PR 描述列出新增依赖名+版本+许可+用途；依赖数量克制（默认 1~3 个），pin 到 semver 范围并提交 lock。

## 7. 禁止事项（loader 静态扫描 + 运行时防护）

1. 禁止 `import` 任何 `core/` 路径、`start-monitor.js`；禁止动态 `import()` 非插件自身文件（**不含裸包名导入**——第三方依赖经 `import x from '<pkg>'`（bare specifier）允许，静态扫描不误报）；
2. 禁止读取含 `KEY`/`SECRET`/`TOKEN`/`PASSWORD`/`COOKIE`/`AUTH`（忽略大小写）的**环境变量**（含 `VRC_MONITOR_MASTER_KEY`）与仓库根目录任何此类配置文件；允许读取 `VRC_MONITOR_*` 公共配置（排除上述敏感项）；
3. 禁止读写数据库文件本体（`data/vrc-monitor.sqlite3*`）；一切持久化走 `api.db`；
4. 禁止访问凭据加密存储、核心 `secure_secrets`（或等价）表、以及任何主密钥解密接口；
5. 禁止 `child_process`（如确需，先开 issue 讨论——OTP 场景是核心能力不是插件能力）；
6. 禁止 `process.exit` / 未捕获的顶层副作用：插件代码必须在 `register()` 内执行，import 时不得有副作用（热加载依赖此保证）。

**loader 静态扫描**：检测 `readFileSync`/`createReadStream`/`openSync`/`readFile` 等调用，路径命中敏感文件（`credentials.json`/`auth_cookie.txt`/加密存储等）或访问受禁 env → 拒绝加载并明示。工具名匹配破坏性前缀（`remove_`/`delete_`/`leave_`/`decline_`/`hide_`/`unfavorite_`/`unfriend_` 等）但未声明 `destructive: true` → 拒绝加载并提示。

**违反 1-5 的插件会被拒绝加载并明示原因；违反 6 属于编码错误，表现为热加载异常。**

## 8. 完整示例（可直接照抄改写）

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

## 9. 版本与兼容承诺

- 本契约当前处于 **experimental 阶段**，`api.provide/consume`（§4.6）等新 API 在达到冻结门槛（**至少 10 个社区插件实践 / 一个发布周期**）前**允许修改或移除**；一旦冻结，转为「只增不改」。
- 本契约随核心 `package.json` major 版本走；冻结后 v1 期间只新增 API（如计划中的 `api.events` 事件订阅、`api.config` 插件配置），不修改既有行为；
- 契约变更在 `docs/PLUGIN-API.md` 顶部 Changelog 记录；
- 官方插件是契约合规的参考实现，疑问先看 `plugins/official/`。

## Changelog

- **v1.3 (2026-09-13)**：新增 §4.7 `api.health(obj)` 运行态上报（`/health.extras.<pluginName>`，键空间按插件名隔离、卸载自动清理；共 7 个 API）。
- **v1.2 (2026-09-05)**：放开插件第三方库限制，落地「插件自带 package.json」依赖机制。
- **v1.0 (2026-08-23)**：初始契约（registerTool / db / vrchat.fetch / log / tools.call 共 5 个 API）。
- **v1.1 (2026-08-23)**：experimental 化；新增 §4.6 `api.provide/consume`（共 6 个 API）+ `api.tools.has`/`api.hasService` 能力探测；§4.2 改显式表句柄 + schema 只增不删约定；§4.1 补 destructive 对偶拦截 / outputSchema 扩展位 / 逻辑隔离定性；§2 补 depends 能力探测与加载期环检测＋破坏性前缀校验；§5 补热加载不中断 + schema 版本可见；§7 补敏感文件/env/加密存储禁读 + loader 静态扫描；凭据入库加密（核心基建，随 PR 演进）。
