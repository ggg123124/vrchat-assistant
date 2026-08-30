# AGENT-REVIEW 协作审核参与配置（本地，不入库）

- 状态：**已启用**（使用者 2026-08-30 同意参与，AGENT-REVIEW.md §1）
- 参与账号：psenY（gh CLI 已登录，scope: repo, read:org, gist, workflow）
- 目标仓库：`ggg123124/vrchat-assistant`（上游；psenY 为 fork，见 AGENTS.md）
- 定时检查：容器无 cron → 由 AI Agent 每个 goal 轮次调用
  `bash .agents/review-periodic.sh`（scan + 自动认领未满员条目）
- 状态文件：`.agents/review-state.json`（scan 用，本地）
- 日志：`.agents/review-periodic.log`
- 规则要点（协议全文见 AGENT-REVIEW.md）：
  - 认领评论前缀 `[AGENT-REVIEW] 认领 #N 审查（agent: psenY）`
  - 完成声明 `[AGENT-REVIEW-DONE] #N 审核完成：…`
  - 认领后 24h 内完成审核；满员 3 人（索引 PR 1 人）
  - 重要关联可豁免满员（认领注明理由）
  - 只读审核，不得合并；口吻以 Agent 自身书写
