---
name: review-workflow
description: "Use when 审核 PR / issue（判断可合并性、多轮修改复核、参与协作审核）。REST-only、端到端实测、分级反馈的完整审核流程。"
version: 1.1.0
metadata:
  hermes:
    tags: [github, review, pr, issue, vetting, multi-agent]
---

# 审核工作流（PR / Issue / 协作审核）

本 skill 面向**任何 AI Agent**：当需要审核一个 PR 或 issue（判断可合并性/可关闭性、多轮修改复核、参与协作审核）时使用。沉淀自本仓库维护方多轮真实审核实践，通用方法可直接复用于其他 GitHub 仓库。

> 权威定义：仓库 `DEVELOPMENT.md`（PR 硬性要求 §2、跨平台约束 §3）、`AGENT-REVIEW.md`（协作审核协议）、`AGENTS.md`（Agent 义务）。本 skill 是执行方法论，冲突以仓库文档为准。

## 触发条件

- 使用者说「审核这个 PR / 看看能否合并 / 他又提交了 / 处理下这个 PR」
- 使用者说「看看这个 issue / 处理下 issue / 这个需求实现了吗 / 能不能关」
- 协作审核（AGENT-REVIEW 协议）中认领了 PR/issue，需要执行审核
- 维护方需要复核自己或他人 PR 的多轮修改

## 核心原则

1. **审核只读，合并/关闭权归维护者**：正式 review（APPROVE / REQUEST_CHANGES / COMMENT）与 issue 结论评论可提交，**merge / push / close 必须先获得明确指令**。「推荐合并」≠「授权合并」，选 review-only 就只提交意见。
2. **REST-only**：gh CLI 的 GraphQL 命令（`gh pr list` / `gh pr view`）对部分仓库会报 `Could not resolve to a Repository`，但 REST（`gh api repos/O/R/...`）正常。**一律用 `gh api`**（记得 `--paginate` 拿全量）。
3. **端到端实测**：不止读 diff——把 PR 文件提取到工作区实际运行（语法检查 / dry-run / mock 数据驱动）。很多问题只有跑起来才暴露（历史实例：`SqliteError: no such table`、async IIFE 恒真值短路、删 return 的「语法合法但功能挂」）。
4. **反馈分级**：🔴 阻断项（合并前必修）/ ⚠️ 警告 / 💡 建议 / ✅ 通过项也要列出。
5. **阻断项附实测证据**：附报错输出/复现步骤，别只说理论——对方的 AI agent 会照做。自报「全部验证通过」≠ 可信，独立写验证脚本重跑。
6. **Agent 口吻**：review/评论文字以 Agent 口吻陈述（可署背后使用者的账号，但不得用人类第一人称「我要…我做了…」）。
7. **新贡献者身份独立判定**：不默认贡献者是人或 agent。老账号+多个公开仓库+个人邮箱 commit = 人类特征；PR body null、工具化口吻 = agent 特征。身份存疑先 `issues/N/comments` 询问，技术审查照常完成，最终处置等身份确认。
8. **多轮 review 提交新评论，不编辑旧发言**：R(n+1) 复核后提交**新的** review（新 body + 新 inline），绝不 PATCH 编辑之前轮次的评论——review 链是历史记录。

## 审查流程

### 1. 收集上下文

```bash
gh api repos/O/R/pulls --jq '.[] | {number, title, user: .user.login, state, draft, created_at, updated_at}'
gh api repos/O/R/pulls/N --jq '{title, body, draft, state, head: .head.sha, head: .head.label, fork: .head.repo.fork, changed_files}'
gh api repos/O/R/pulls/N/files --paginate --jq '.[] | "\(.status) +\(.additions)/-\(.deletions)  \(.filename)"'
gh api repos/O/R/pulls/N/commits --jq '.[] | "\(.sha[0:7]) \(.commit.message | split("\n")[0])"'
```

- ⚠️ **先对 remote 再动手**：`git remote -v` 拿真实仓库名（cron prompt/记忆里的名字可能过时、写错导致 404 绕圈）。
- **draft PR**：GitHub 禁合并，评论照发但合并讨论等作者转 Ready for review。
- **「看 issue」≠「看 PR」**：使用者说「扫描一下/提交了个新的」时同时查 open issues 和 open PRs。

### 2. 看 diff（git 通道 + REST 通道双保险）

- git 通道：`git fetch origin pull/N/head:pr-N && git diff main...pr-N`（网络好时；fetch 失败不阻塞审查）
- **REST 通道（git 连不上时仍可用）**：
  - 文件 patch：`gh api repos/O/R/pulls/N/files --paginate --jq '.[].patch'`
  - 增量对比：`gh api repos/O/R/compare/<旧sha>...<新sha> --jq '.files[] | "--- \(.filename) ---", .patch'`
  - 取某 ref 文件全文：`gh api repos/O/R/contents/<path>?ref=<sha> --jq '.content' | base64 -d`

### 3. 提取 PR 代码到工作区实测

- 首选：工作区干净 + fetch 可达时 `git checkout prN` 切 PR 分支实测（import 相对路径/`__dirname` 资源定位全部天然正确）。
- 备选：REST 提取单文件。⚠️ **可 import 模块/含 `path.join(__dirname,...)` 的必须放回原目录**（放仓库根会按相对路径解析错）。
- 语法检查用**项目目录内 `.mjs` 临时文件**（`node --check`；不用 stdin、不用 /tmp——Windows 原生 node 会把 MSYS /tmp 转成 `D:\tmp` 找不到）。
- 测试库用 `:memory:` 或临时文件，**绝不碰生产库**。
- 测完恢复工作区：`git status --porcelain` 确认干净，精确删除临时文件。

### 4. 提交 review

```bash
# review JSON（inline comments + 结论，原子提交；--input 传文件避免转义地狱）
gh api repos/O/R/pulls/N/reviews --input review.json
# review.json 形如 {"commit_id": "<head-sha>", "event": "APPROVE|REQUEST_CHANGES|COMMENT", "body": "...", "comments": [{"path": "...", "line": <新文件行号>, "body": "..."}]}
# 普通进展评论（多轮时用，别重复整篇 review）
gh api repos/O/R/issues/N/comments --input - <<'EOF' {"body": "..."} EOF
```

- ⚠️ **inline 行号必须落在该文件 diff hunk 内**（`@@ -X,N +Y,M @@` 范围，hunk 外的内容放 review body）——否则 422 整条 review 被拒。
- ⚠️ **AGENTS.md 等未在 PR files 里的文件无法发 inline**，只能 review body 点名文件+行号。
- MSYS 环境：`--input`/`--body-file` 传路径用 Windows 格式 `D:/...` 或 `$(cygpath -w ...)`。

### 5. 读回验证（REST 读回 = 可信证据，自报不算）

```bash
gh api repos/O/R/pulls/N/reviews --jq '.[] | {state, commit_id, submitted_at}'
gh api repos/O/R/pulls/N/comments --jq '.[] | .path, .line, .body[0:40]'
```

- ⚠️ `pulls/N --jq '.review_decision'` 可能持续 null（聚合字段延迟），**以 `pulls/N/reviews` 端点为权威**；别因 null 反复重发 review（会叠加重复记录）。

### 6. 多轮修改管理

- **每轮先复测上一轮的 🔴 阻断项是否真修**——作者可能推重构/新功能而完全不动阻断项；「提了新 commit ≠ 修了问题」。
- 用 `compare/<旧sha>...<新sha>` 精确看增量，别整文件重读。
- 修复 commit 本身是**新回归源**：作者「修复」常重写实现方式，对最新 head 重跑完整场景矩阵（含脏数据/边界），不只比对增量 diff。
- **本地 `prN` ref 可能陈旧**：fetch 失败后 `git show prN:file` 是旧内容——先 `gh api pulls/N --jq '.head.sha'` 对 SHA，结论一律以 REST 按 head SHA 提取的内容为准。

### 7. Issue 审核（与 PR 审核并列的第二对象）

Issue 不是「关不关」的二选一——先判断**需求是否已实现**，再决定处置：

1. **收集上下文**：`gh api repos/O/R/issues/N --jq '{title, body, state, labels, assignee, comments, created_at, updated_at}'` + `issues/N/comments --paginate` 看讨论历史。
2. **需求实现核查**：从 issue body 提取验收点清单 → grep 代码（`gh api repos/O/R/contents/<path>?ref=main`）确认每个点是否落地 → 关联 PR（`gh api search/issues?q=repo:O/R+"#N"+in:body` 或看 PR 引用了 `fixes #N`）。
3. **关闭前逐条核对验收点**：全部实现 → 发关闭说明评论（列「哪些落地/如何验证」）→ PATCH `state=closed`；有未实现项 → **拆独立新 issue**（body 带原始需求 + 已落地部分 + 剩余项 + 关联链）再关原 issue，别整体关掉留「以后再说」。
4. **证据要求**：结论评论附可复现证据（定位到模块/函数级别）；「已实现」用代码路径 + 实测输出说话，别凭 PR 合并状态判断。
5. 关闭后读回验证：`gh api repos/O/R/issues/N --jq '{state, closed_at, closed_by}'`。
6. ⚠️ `fixes #N` 在 commit message（直接 push main）或 PR body（squash 合并）都会**自动关 issue**——push/合并后读回确认，无需手动 PATCH。

### 8. 合并（维护者明确授权后）

```bash
gh pr merge N --squash   # squash 避免"加了又删"的中间 commit 噪音
gh api repos/O/R/pulls/N --jq '{merged, state, merge_commit_sha}'
gh api repos/O/R/branches/main --jq '.commit.sha'          # main 尖端 = merge sha
gh api repos/O/R/commits/<merge-sha> --jq '[.files[].filename]'  # 合并内容无夹带
```

- `gh pr merge --squash` 走 GitHub API，git 通道全断也能合并。
- 合并后本地 `git fetch origin main` + ff-only 同步。
- `.merged` 变 true 先查 `merged_by`——使用者可能自己点合并；终态验证从已合并 main 的 merge_commit_sha 提取。
- 合并 → 重启服务加载新代码 → 轻量新工具真实调用验证链路 → 重任务后台跑 → 产物验证。到「跑起来」只是链路通，**产物出来才叫端到端验证完**。

## 针对本项目（vrchat-assistant）的专项审查面

### 工具数精确核对

- 以仓库自带的**权威工具清单**为准：`node scripts/dump-tools.mjs`（来自 `core/registry.js` 的 `listTools()`，含核心 + 插件工具）。用它输出双端（main / PR）工具集合做差集：

```bash
node scripts/dump-tools.mjs > tools-head.txt   # 当前分支全部工具名（含插件工具）
# 切到 main 再跑一次 > tools-main.txt，然后 diff 两个文件得差集
```

- **工具数基线**：PR head 数 = 分叉点基数 + PR 新增；合并后 main = 当前 main 数 + PR 新增。用 `compare/<base>...<head>` 的 `{ahead_by, behind_by, status}` 判分叉，不能照抄 PR body 数字。
- 并发多 PR 都加工具时，文档数字按合并顺序由维护方统一校准。

### 文档 vs 代码矛盾（高频阻断项）

- PR 的 README/AGENTS/工具描述声称的每条用法**逐一对应代码路径**——「文档宣传 vs 代码 gate」矛盾是纯读 diff 就能抓的隐藏阻断项（实例：README 说非 Windows 走 API 回退，代码却 exit(1)）。
- 「限速/节流/延时」声明对照代码实现：grep 声称的限速点（sleep/await delay），无实现则 🔴（文档声明会误导后续维护者）。
- 「文档已同步」声称逐文件 grep 核对三处（README / AGENTS.md / SKILL.md 工具表），别信 commit message。
- 文档数字冲突不能取任何一边：以代码实值为准（`grep -c "name: '"` 减 UI 标签数），三处统一写真实数。

### 夹带删除检测（PR 主题 ≠ diff 内容时）

- 对比 main 与 PR 的工具注册数（差 = 删除/新增数），再看 head 父链——父 commit == main tip 说明删除是有意提交，必须打回要求恢复或单独 PR。
- 空壳同步 PR 判定：`git diff <base-sha> <head-sha>` 为空 = PR 树与 main 完全一致（GitHub 显示的 +N/-M 是按旧 merge-base 对比的假象），合并 = no-op——打回。

### 迁移/DDL 审查

- **既有表加列必须 ALTER 而非只改 CREATE**：`:memory:` 模拟存量库（用旧版 init-db.sql 完整 CREATE 建表 + 插数据）+ PR 版 init 实测——mock 表必须带全部既有列（`CREATE INDEX IF NOT EXISTS ... ON 表(旧列)` 引用旧列，缺列则 exec 报 `no such column` 假崩溃）。
- **表名 RENAME 必须在 DDL exec 之前**（否则 `CREATE TABLE IF NOT EXISTS 新名` 先建空表 → RENAME 冲突失败 → 老数据成孤儿）；索引跟随（SQLite RENAME 自动重绑但索引名不变，需 DROP 旧 + DDL 建新）。
- 幂等迁移（INSERT OR IGNORE + 唯一索引）验证矩阵：空库跑 2 次 / 源库追加后重跑 / 实时数据连插 / 旧库无标记保护 / 索引存在性。
- 迁移脚本服务运行中实测：复制脚本改探测端口绕过前置检测，目标库用临时文件。
- 迁移脚本对运行中库验证：mock 源库 → 临时目标库 → `integrity_check: ok` + 无 `-wal`/`-shm` 残留 + 生产服务健康接口计数持续增长（零接触证明）。

### 外部集成可达性（大陆网络 / 第三方平台）

- 连通性分直连/代理两路实测；HTTP 200 空壳要**多客户端交叉验证**（curl 的 Schannel/无 HTTP/2 会被防护识别返回空壳，浏览器/node:https 正常）——单工具空壳不能下「源已死」结论。
- node 原生 fetch（undici）**不认 `agent` 字段**只认 `dispatcher`——「代理支持」声称用死代理（127.0.0.1:9）实测：仍返回 200 = agent 被静默忽略 = 纸面修复。
- 外部 RSS/HTML 解析用**真实抓取内容**喂解析器（别只喂自己构造的干净样例）——链接显示文本截断会被正则误收为残片 ID。

### 个人数据不入仓库（架构原则）

PR 新增「个人数据文件」（翻译缓存/昵称表/备注 JSON）进仓库 = 默认打回，除非有明确共享语义（模板/默认值/示例）。正确架构：本地 DB 表 + 服务端 handler 输出附加字段。

### 认证/登录流程类 PR

mock 网络方法 on **真实 client 实例**（替换 `_request`/`_basicAuthRequest` 等方法返回构造响应），别 mock ctx.api——场景矩阵直接驱动完整登录生命周期（2FA 分流/端点断言/失败保留 tempCookie 可重试/session 残留对称性）。

## 陷阱速查

- **`--jq '.[] | {...}'` 单元素结果输出对象非数组**：`isinstance(list)` 判断会误判，用 `map({...})` 恒保数组。
- **纯文档 PR 也要实测验证**：格式定义 vs 示例逐列比对（列数矛盾 🔴）；「用户固化要求」类声称用 session_search/issue 历史验证，无据不直接采信也不直接打回，交使用者拍板。
- **async IIFE 塞进同步 `||` 链 = 恒真值短路**（`const x = env || (async () => {...})() || default`）：async 返回 Promise 恒 truthy，默认分支永远不可达——同步短路链里出现 async IIFE 一律 🔴。
- **「修逻辑」commit 可能删掉 return**：对被改函数同时检查 try/catch 两条路径都有 return（node --check 语法过、成功路径恒 undefined）。
- **upsert 双重序列化**：调用方预 `JSON.stringify` + storage 内部再序列化 = 库里存 `"[\"game\"]"` → 读回 `JSON.parse` 得字符串非数组 → 数据静默丢失。查库 `WHERE 列 LIKE '"%"' AND json_valid(列)`；修复 = 写路径传数组 + 读路径 `Array.isArray` 防御 + 存量清理。
- **SQL 兜底/COALESCE 注释意图 vs 实际覆盖范围做差集审查**：不满足意图的分支返回 NULL 由上层安全降级，别让过期时间当起点。
- **缓存写路径只覆盖成功分支 = 负缓存缺失**：失败项每次调用重试，建议补 null 缓存行 + 短 TTL。
- **验证脚本断言别用 jq 截断字段做精确比较**（中文按字符截断误判）——用包含匹配 `case "$var" in *子串*) PASS;; esac`。
- **child_process 拼接命令**：可执行路径含空格被 cmd.exe 截断——`"${bin}"` 加引号；execFileSync 数组传参天然免疫。
- **身份违规只看口吻**：署名可以用背后使用者的账号/邮箱，但文字不得用人类第一人称。

## 协作审核（AGENT-REVIEW 协议）

参与协作审核（本仓库或支持该协议的其他仓库）时：

1. 协议权威定义在仓库根 `AGENT-REVIEW.md`，参考脚本 `scripts/agent-review.py`（子命令 status / scan / claim / withdraw / mine）。
2. 流程：`scan` 看变化 → 筛选候选（跳过 draft/已满/自己已认领/自己是作者）→ `claim <N> --user <login>` → 认领成功**当场开始审核**（24h 内完成）→ 完成后发 `[AGENT-REVIEW-DONE]`。
3. 认领评论第一行必须精确：`[AGENT-REVIEW] 认领 #<N> 审查（agent: <login>）`；完成：`[AGENT-REVIEW-DONE] #<N> 审核完成：<结论>`。
4. 审核时在 review 开头注明「审核环境：<实测/静态/评论级>；使用者视角：<一句话>」。
5. 边界：**只读**，绝不 merge/push/close；认领后超 24h 无完成证据 = 失效，其他 agent 补位。
6. 重要关联豁免（协议 §2.4）：PR/issue 与使用者有重要关联（使用者是提出者/实现的是使用者需求/被 @ 点名）时即使满员也认领，附 `--related "<理由>"`。

## 权威文件

- `DEVELOPMENT.md` §2（提交 PR 的要求：单一职责/无硬编码/DB 迁移/文档同步/三段式验证）与 §3（跨平台约束）
- `AGENT-REVIEW.md`（协作审核协议）
- `AGENTS.md`（Agent 义务：发现漏洞必须主动开 issue + 提修复 PR）
