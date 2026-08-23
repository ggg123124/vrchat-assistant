---
name: vrchat-assistant-development
description: "Use when developing new features or fixing bugs in the vrchat-assistant repo: add an MCP tool, modify existing behavior, or submit a PR. Loads the authoritative DEVELOPMENT.md before any code change."
version: 1.0.0
metadata:
  hermes:
    tags: [vrchat, development, mcp, feature, pr]
---

# vrchat-assistant 开发 Skill — 新增功能 / 修改功能 / 提交 PR

本 skill 面向**任何 AI Agent**：当使用者要求给 vrchat-assistant 添加新功能、修改现有功能、修复 bug，或提交 PR 时使用。

## 触发条件

- 使用者说"给 vrchat-assistant 加个功能 / 做个工具 / 改一下 XX 行为"
- 使用者要求在仓库内新增脚本、MCP 工具、数据库字段、定时任务
- 使用者要求修复 bug 并提交 issue + PR
- 任何对 `core/`、`start-monitor.js`、`hermes-plugin/`、`desktop/` 下代码的修改

## ⚠️ Phase 0（强制）：检查仓库归属

**动手之前先确认当前仓库是用户自己的 Fork，不是中央仓库。** 开发/修改功能必须发生在用户自己的仓库里：

```bash
git remote get-url origin
```

- 若 origin 指向 `ggg123124/vrchat-assistant`（**中央仓库**）→ **停止开发**，提示用户先创建自己的仓库（Fork 中央仓库），再克隆 Fork 继续。不要直接在中央仓库 clone 上开发——Agent 的代码变更无法推送、且可能污染上游
- 若 origin 指向用户自己的账号（如 `https://github.com/<用户名>/vrchat-assistant.git`）→ 正常继续
- 检查是否有 upstream：`git remote -v` 应显示 `upstream → https://github.com/ggg123124/vrchat-assistant.git`（fork 来源，用于同步官方更新 `git pull upstream main`）。缺 upstream 时提示可补，但不阻塞开发

Fork & Clone 完整流程见 `AGENTS.md`「获取代码（Fork & Clone）」章节。

## ⚠️ 第二步（强制）：读取权威开发规范

**动手写任何代码之前，先完整读取仓库根 `DEVELOPMENT.md`**——它是开发规范的唯一权威来源，作者会持续维护，可能与本 skill 的编写时间不同步。禁止凭记忆或凭本 skill 的概述代替它。

```bash
cd <仓库根目录>   # 即本仓库 clone 下来的位置
cat DEVELOPMENT.md                  # 或 read_file
```

读取顺序建议：`README.md`（概览）→ `AGENTS.md`（部署）→ `ARCHITECTURE.md`（架构）→ `DEVELOPMENT.md`（**开发约束，§3 跨平台必读**）。每次开发任务都重新读，不假设内容与上次相同。

> 本 skill 只负责「流程编排 + 仓库导航」，规范正文以仓库文件为准。若发现 DEVELOPMENT.md 与本 skill 描述冲突，以 DEVELOPMENT.md 为准。

## 总体原则（概述，细节见 DEVELOPMENT.md）

- **AI 完成开发，人类只提需求**：使用者不直接编码。流程 = 需求 → 读文档 → 实现 → 自测 → 使用者验收 →（可选）PR
- **新功能默认做成 MCP 工具**，禁止只写孤立 CLI 脚本（Agent 通过 MCP `tools/call` 与功能交互）
- **身份表达**：issue / PR / commit 一律以 AI Agent 口吻书写，不冒用使用者人称（"使用者提出…"而非"我需要…"）
- **fork 自由、PR 自愿**；发现缺陷是义务，必须主动上报（issue + 修复 PR）

## 仓库导航（在哪里改）

新增一个 MCP 工具的注册位置（细节规范见 DEVELOPMENT.md §5）：

| 组件 | 位置 | 说明 |
|------|------|------|
| 核心工具 def | `core/tools/<域>.js` | 文件默认导出 `tools` 数组（自声明 name + description + inputSchema + handler），启动时经 `core/registry.js` 注册 |
| 插件能力 def | `plugins/official/<域>/index.js` | 默认导出 `register(api)`，经 `api.registerTool` 定义工具；数据/能力经 `api.consume` / `api.vrchat.fetch` 复用核心 |
| 注册表 | `core/registry.js` | 按 `core/tool-order.json` 混合索引核心 + 插件工具，提供 `listTools` / `dispatch` |
| 文档登记 | `skills/vrc-monitor-agent/SKILL.md`「MCP 工具」表格 | **权威登记位置**（2026-08-15 起 README 不再平铺工具清单；AGENTS.md §6 采样列举同步补名；BOOTH 域另登记 `skills/booth-query-display/SKILL.md`） |

模块职责速查见 `ARCHITECTURE.md`「core/ 模块职责」表（storage / ws-manager / event-pipeline / rate-limiter / server-context 等）。

## 提交流程（规范见 DEVELOPMENT.md §2 / §6 / §7）

1. 开发完成 → **实际运行验证**（`node start-monitor.js` + `/health`；相关 `test-*.mjs` 脚本；新工具用 curl 走一遍真实 MCP 调用）
2. 文档同步：新工具登记进 skill 工具表格（+ AGENTS 列举 + README 能力域描述若涉及）
3. `python scripts/check-doc-drift.py` 确认退出码 0、无漂移
4. `git status` 自查无敏感文件 → Conventional Commits 提交 → 按需 PR（三段式：需求来源 → 实现方式 → 验证过程与结果）
5. 完整自检清单见 DEVELOPMENT.md §7

## Pitfalls（仓库实操经验，正文以 DEVELOPMENT.md 为准）

- ⚠️ **不要只写 CLI 脚本**：新功能必须是 MCP 工具（核心工具 `core/tools/*` 自声明，或插件 `plugins/official/*` + `api.registerTool`，统一并入 `core/registry.js`），否则 Agent 无法调用
- ⚠️ **限流不要嵌套**（2026-08-09 真实死锁）：handler 内已逐请求限流时，RPC case 层不要再包一层 rateLimiter.execute，会整 handler 挂死
- ⚠️ **工具登记位置已变更（2026-08-15）**：权威登记 = `skills/vrc-monitor-agent/SKILL.md` 工具表格，不是 README
- ⚠️ **README / skill 不写工具总数**：全仓库禁止"N 个 MCP 工具"表述，只维护工具名清单
- ⚠️ **DB 变更必须幂等迁移**：存量库 vrc-monitor.sqlite3 存在，ALTER TABLE 用 IF NOT EXISTS
- ⚠️ **Windows 增强必须可回退**：命名管道等平台专属逻辑，探测失败要静默回退跨平台路径，功能不缺失
