/**
 * 插件模板 —— index.js
 * =====================================================================
 * 一个插件 = 一个文件夹（这里就是 docs/plugin-template/），放置到：
 *   plugins/official/<name>/   → 官方插件（随主仓发布）
 *   plugins/local/<name>/      → 用户私有插件（gitignore，不入库）
 *   $VRC_MONITOR_PLUGINS_DIR   → 额外插件目录
 *
 * 复制本文件夹为 plugins/local/<name>/，把 plugin.json 的 name/version/description
 * 改成你的值，再把下文 tool 名从 my_* 改成你的前缀即可。保存即热加载（无需重启服务）。
 *
 * ── 核心约定（契约 v1.1，权威见 docs/PLUGIN-API.md）─────────────────────
 * 1. 只准通过函数入参 `api` 与核心交互，**绝不 import 任何 core/ 路径、
 *    start-monitor.js，绝不触碰全局 ctx、绝不直连数据库文件**。
 * 2. index.js 必须默认导出 `register(api)`（可同步或返回 Promise）。
 * 3. 对外暴露能力一律用 `api.registerTool(...)`（MCP 工具）。
 * 4. 需要核心能力/数据 → `api.consume("<域>.<名>", args)`（核心服务）；
 *    需要调某个已注册工具 → `api.tools.call(name, args)`；
 *    需要自有表 → `api.db.table("<alias>")`（核心强制加 plg_<name>_ 前缀）。
 * 5. 需要调 VRChat REST → `api.vrchat.fetch("/path", {method, body})`
 *    （自动带核心登录态与限流，插件永远接触不到凭据）。
 * ─────────────────────────────────────────────────────────────────────
 */
export default function register(api) {
  // ── 例 1：一个自包含工具（无凭据可跑，适合冒烟）────────────────────────
  api.registerTool({
    name: "my_plugin_ping",
    description: "[query] 插件自检：返回插件名/版本/当前时间，无凭据可调用。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      return { plugin: "my-plugin", version: "0.1.0", now: new Date().toISOString() };
    },
  });

  // ── 例 2：委托核心服务（world-kb 的 api.consume 模式）─────────────────
  // 世界知识库/world-kb 等官方插件用 `api.consume("world.<name>", args)` 把
  // 参数转交核心服务，自身不存业务逻辑。参考 plugins/official/world-kb/index.js：
  //
  //   handler: async (args) => api.consume("world.getNewWorlds", args)
  //
  // 核心服务组（start-monitor.js 的 registerCoreServices() 暴露）：
  //   storage.<method> / x.<name> / world.<name> / recommend.<name>
  // 注意：consume 的服务必须已被 provide，且依赖拓扑保证提供方先加载；
  //       用 api.hasService(<name>) 探测是否存在（配合 depends 区分"没装"vs"版本不兼容"）。
  //
  // api.registerTool({
  //   name: "my_world_query",
  //   description: "[query] 查询世界知识库里的新世界。",
  //   inputSchema: { type: "object", properties: { limit: { type: "number", default: 10 } } },
  //   handler: async (args) => {
  //     if (!api.hasService("world.getNewWorlds")) {
  //       return { error: "world-kb 插件未安装或未加载" };
  //     }
  //     return api.consume("world.getNewWorlds", args);
  //   },
  // });

  // ── 例 3：自有表（api.db，核心强制 plg_<name>_ 前缀）──────────────────
  // 需要持久化本地状态时，用 api.db.table("<alias>")。SQL 由句柄层重写为
  // 实际表 plg_<name>_<alias>；建表请放 schema.sql（可选，加载时自动执行，幂等写法）。
  //
  // const seen = api.db.table("seen");
  // seen.run("INSERT OR REPLACE INTO seen (name) VALUES (?)", ["someone"]);
  // const rows = seen.all("SELECT * FROM seen ORDER BY name");

  // ── 可选：返回清理函数（dispose），热卸载/重载时调用 ─────────────────
  // 清理定时器、句柄等；持久化状态不用清理（在 api.db）。
  // return function dispose() { api.log("my-plugin 正在卸载"); };
}
