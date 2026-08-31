# VRCX 对齐与实时验证

## 适用场景

用于把 headless、MCP-first 服务的远程 Dashboard 持续对齐到 VRCX 式桌面信息架构：左侧功能导航、中间高密度工作区、右侧好友栏、玩家 Inspector 和底部状态栏。

## 实现原则

1. 优先实现真实工作流，不添加装饰性假数据。
2. 玩家 Inspector 可按现有能力提供“资料 / 活动 / 世界 / Avatar / 群组”标签；接口不存在或没有数据时明确显示空状态或不可用状态。
3. 通知工作区复用现有通知读取工具，提供类型筛选、分页、加载/错误/空状态；只接入低风险的标记已读写操作，不把隐藏、接受好友请求等破坏性动作混入监控界面。
4. 全局事件与指定好友事件必须使用相同 DTO 归一化规则：事件显示名优先，其次好友快照显示名，再回退到 `usr_...`。历史事件缺显示名时要从 `friends` 快照补齐。
5. 插件通过 `api.consume` / `api.tools.call` 复用核心能力，不复制 VRChat API、认证或数据库逻辑。
6. 页面字符串全部转义；服务端分页参数必须收敛；异步服务必须 `await` 后再序列化。

## 本地验证

- 对所有变更的 JavaScript 运行 `node --check`。
- 从 HTML 提取内嵌 `<script>` 后单独运行 `node --check`。
- 用 mock `api.consume` / `api.tools.call` 注册并调用插件路由，验证返回的是实际 JSON，不是 Promise，并验证非法/超大分页参数被收敛。
- 运行 `git diff --check`。
- 依赖未安装时，不声称 `test-registry.mjs` 或文档漂移检查通过。

## 路由器闭环

1. 从当前工作副本内存打包，不使用邻近旧 checkout。
2. 排除 `.git`、`node_modules`、`data`、`backups`、`.env`、`credentials.json`、Cookie、通知配置、SQLite/WAL/SHM、缓存和日志。
3. 通过 SSH/Paramiko 上传到临时远端路径，解压到应用目录，执行 `docker-compose up -d --build`。
4. 读回容器 `Up ... (healthy)`、端口映射、启动日志、插件状态和 WebSocket 状态。
5. 未授权 Dashboard 请求应为 `401`；鉴权 `/health` 应为 `200`、`ok: true`、认证成功、WebSocket connected、目标插件 loaded。
6. 用真实事件样本交叉验证 `/events` 与 `/friend-events` 的同一 `userId` 显示名一致；新标签接口分别验证 HTTP 状态和字段结构。
7. 容器没有 `curl` 时，用容器已有 Node `fetch`，从环境变量注入 Token，但绝不输出 Token。
