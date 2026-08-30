# Fork 同步上游 PR 工作流

> 触发：用户说“上游合并了别人的 PR，我们需要同步之后再继续开发”。
> 适用：维护 GitHub fork + 长期部署在远程（路由器 Docker）的仓库，本地有大量未提交改动时的同步。

## 用户约定（重要）

- **本地 commit 是同步的必要步骤**（否则 merge 无法干净进行），可直接做；但 **push 到 origin（自己的 fork）必须等用户明确要求**。
- 项目历史用 merge commit 风格（`Merge pull request #xx`），同步优先 `git merge upstream/main`（上游领先时自然 fast-forward）。
- 同步完成后必须：本地验证（语法/单测/冒烟）+ 部署到路由器 + 容器探针，才算“同步完成”。

## 步骤

1. **检查远程配置**：`git remote -v`。upstream 远程**可能丢失**（只剩 `remotes/upstream/main` 遗留跟踪分支）——本会话就遇到 `fatal: 'upstream' does not appear to be a git repository`。丢失则：
   `git remote add upstream https://github.com/<上游owner>/<repo>.git`

2. **fetch 上游**：`git fetch upstream`

3. **评估冲突范围**（关键，决定同步风险）：
   - `git log --oneline HEAD..upstream/main | head` — 上游新提交
   - `git diff --stat HEAD upstream/main | tail` — 上游改动文件
   - 把上游改动文件与本仓库未提交改动文件做**重叠检查**（for 循环 grep）。重叠越少，fast-forward/merge 越安全。本会话上游改 favorites 插件/safe-mode/tool-order，与本仓库改的 web-dashboard/event-pipeline/start-monitor **零重叠** → fast-forward 无冲突。

4. **commit 本地改动**（不 push）：
   - 若 git 报 `unable to auto-detect email address`，先配**仓库级**身份（勿动全局）：
     `git config user.name "<fork名>" && git config user.email "<fork名>@users.noreply.github.com"`
   - `git add -A && git commit -m "feat(dashboard): <改动摘要>"` — commit message 分条列改动的模块/性能/对齐/修复/质量/文档。

5. **merge 上游**：`git merge upstream/main --no-edit`
   - 无重叠文件时直接 fast-forward；有重叠则解决冲突后 `git merge --continue`。

6. **本地验证**（同步后全量）：
   - 上游改动文件的语法（本会话上游改了 `plugins/official/favorites/index.js`）——不能只验自己的文件。
   - 全部后端 `node --check` + 前端拼接 JS `node --check` + `npm test` + `git diff --check`。

7. **部署 + 容器探针**：tar 打包（排除 .git/node_modules/data/backups/*.sqlite3/credentials/.env）→ 上传路由器 → `docker-compose up -d --build` → 等 healthy → `node scripts/dashboard-probe.mjs`（PASS N/N）。

## 常见陷阱

- 直接 `git fetch upstream` 前**先确认 upstream 远程存在**（配置会因 clone/re-clone 丢失）。
- merge 前**先 commit 未提交改动**，否则 fast-forward 可能因“would be overwritten by merge”被拒或丢失。
- 上游新提交可能优化了 Dashboard 依赖的接口（本会话 favorites 插件改为 `/worlds/favorites` 一次拉全，收藏世界首调 15-20 分钟→秒级）——同步后值得实测对应 Dashboard 页面是否变快。
