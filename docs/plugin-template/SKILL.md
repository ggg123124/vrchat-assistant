# my-plugin —— 插件能力说明（模板）

> 本文档是插件的 **SKILL.md**，给调用你的 AI Agent 看：告诉它这个插件能做什么、怎么用。
> 只需把本文件放进 `plugins/local/<name>/SKILL.md`（或 `docs/plugin-template/` 下随插件分发），
> 改写「能力」「用法」两节即可。

## 能力

- **my_plugin_ping**：自检工具，返回插件名 / 版本 / 当前时间。用于验证插件已成功加载并注册，无凭据可调用。

## 用法

Agent 直接通过 MCP `tools/call` 调用上述工具，无需 curl 手写 JSON-RPC。例如：

```
my_plugin_ping  （无参数）
```

返回：

```json
{ "plugin": "my-plugin", "version": "0.1.0", "now": "2026-08-23T00:00:00.000Z" }
```

## 开发提示

- 插件只准通过 `api` 对象与核心交互，**不得 import `core/`、触碰 `ctx`、直连数据库文件**。
- 对外暴露能力一律 `api.registerTool({ name, description, inputSchema, handler })`。
- 需要核心能力/数据 → `api.consume("<域>.<名>", args)`；需要调别的工具 → `api.tools.call(name, args)`；
  需要自有表 → `api.db.table("<alias>")`（核心自动加 `plg_<name>_` 前缀）。
- 权威契约见 `docs/PLUGIN-API.md`（v1.1），开发指南见 `docs/PLUGIN-DEV.md`。

> ⚠️ 重要：`api.registerTool` 注册的工具**只有其名字在 `core/tool-order.json` 中**，
> 才会出现在 `tools/list`（registry.listTools() 只遍历该清单）。若想让 Agent 在
> `tools/list` 里看到你的工具，需把工具名补进 `core/tool-order.json`；若只是给
> 其他插件用（`api.tools.call` 或 `hasTool`），则无需改它。详见 ARCHITECTURE / registry.js。
