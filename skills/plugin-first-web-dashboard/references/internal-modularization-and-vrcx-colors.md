# Dashboard 模块化与 VRCX 颜色证据

## 单插件内部模块化

当 Dashboard 仍由一个 Hermes 插件提供、但后端入口和前端单文件持续膨胀时，保留一个 `register(api)` 生命周期，拆成普通 ESM 模块：

- `server/http.js`：响应、参数限制、JSON body。
- `server/state.js`：缓存状态、TTL、缓存读写。
- `server/routes/<domain>.js`：按搜索、收藏、Avatar、社交等业务域注册路由。
- `client/`：CSS、浏览器 API、状态和视图模块。

主入口只负责组装模块、持有共享状态和生命周期 disposer。不要为了静态拆分再引入子插件加载器；只有需要独立安装、权限或启停生命周期时才值得增加动态子插件机制。

迁移顺序：公共 HTTP 工具和缓存状态 -> 低耦合路由域 -> 高耦合路由域 -> CSS 资源 -> 浏览器 API/state -> 各页面 view。每阶段保持路由路径、返回 DTO、鉴权和 SSE 行为不变，并做 `node --check`、注册 mock、`git diff --check` 和真实端点探针。

## VRCX 信任等级颜色核验

本次从 VRCX 源码 `src/shared/utils/userTransforms.js` 与 `src/views/Settings/components/Tabs/InterfaceTab.vue` 核验：

| VRChat 等级 | VRCX trust key | 默认颜色 |
|---|---|---|
| Visitor | `untrusted` | `#CCCCCC` |
| New User | `basic` | `#1778ff` |
| User | `known` | `#2bcf5c` |
| Known User | `trusted` | `#ff7b42` |
| Trusted User | `veteran` | `#b18fff` |
| VRChat Team | `vip` | `#ff2626` |
| Nuisance | `troll` | `#782f2f` |

注意：VRCX 内部 tag key 与显示名称存在偏移：`system_trust_trusted` 映射为 Known User，`system_trust_veteran` 映射为 Trusted User。不要凭名称或旧资料猜颜色，先查源码的 `computeTrustLevel` 和 `trustColorEntries`。

## 验证陷阱

- 仅 `node --check` 不能证明插件加载；还要用 mock `register(api)` 检查路由无重复且返回 disposer。
- `test-registry.mjs` / `check-doc-drift.py` 依赖项目安装状态；缺少 `better-sqlite3` 时应明确报告为未运行成功，不要改写成代码失败。
- 从内联 HTML 抽 CSS 时，若页面由后端读取并注入资源，必须替换所有占位符，并对最终 HTML 检查占位符数量为 0。
