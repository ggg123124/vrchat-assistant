## v3.0.0 — 插件化架构重构（正式版）

**定位**：v3.0.0-beta（08-23）转正为稳定版。核心已完成从「三件套集中式工具注册」到插件式架构的转身，工具数维持 92。行为兼容基线（91 工具逐字节一致 + 新增 `set_world_sleep`）持续守住，调用方式与返回结构不变。

### 自 beta 以来的关键改动

**X 源头浏览器抓取（#82/#87，PR #96）**
- Nitter/SearchTimeline 2026 双源失效后引入 Playwright 浏览器抓取
- 补齐 Anubis challenge 处理 + 通道自动探测 + env 时序重构
- 双数据源降级（主力失败自动切备源），修复单源漏抓

**Node 22 对齐（#95）**
- engines 与 CI 矩阵从 18/20 收窄到 22（匹配插件零依赖契约口径）

**协作体验增强**
- 群组公告自动联查发布者真实用户名（authorName）
- 逛过即自动移出待逛列表（visited 首次置位同步清 backlog，#91）

**CI 加固（#93）**
- dump-tools 计数断言去硬编码，行数与 tool-order.json 动态对齐

**文档治理**
- 三语 README 对齐 Node≥22；plugins/index.json 去工具数；drift-check 数字残留扫描纳入 plugins/+docs/

### 架构回顾（v3.0.0 主版本）

- 工具自声明 + 注册表自动生成（`core/registry.js`），移除旧三件套（`mcp-definitions.js`/`rpc-router.js`/`handlers/*`）
- 插件化：`core/plugin-loader.js` + `core/plugin-api.js` + 8 官方插件 + 35 核心服务，契约 `docs/PLUGIN-API.md`
- 贡献模型切换：功能一律进插件，`core/` 只收 fix 与底座演进
- storage 底座拆分：按域拆 4 模块 + 独立社交分析域，1582→523 行（行为等价，快照基线守护）
- 安全模式（#84）：`VRC_MONITOR_SAFE_MODE=true` 移除破坏性工具

### 使用说明

- **行为兼容**：92 个工具全部保留，调用方式与返回结构不变
- 新功能提交走插件形态（`docs/PLUGIN-DEV.md` 为入口）
- 自用插件放 `plugins/local/`（gitignore），分享走 `plugins/index.json` 索引 PR

### 贡献者

- @ggg123124（作者 / 维护者）
- @nixi-agent（插件化重构 PR-1/2/3、转正发布）
- @Menaed（#84 安全模式）
- @CyberNekokoya（世界知识库增强 #74/#75/#77/#80）
