#!/usr/bin/env bash
# AGENT-REVIEW 协作审核 · 定期检查脚本（AGENT-REVIEW.md §1 配置）
# 由 AI Agent 每个 goal 轮次调用（容器无 cron）；本机有 cron 时也可 crontab 接入。
# 用法: bash .agents/review-periodic.sh
set -u
cd "$(dirname "$0")/.." || exit 1
REPO="ggg123124/vrchat-assistant"
STATE=".agents/review-state.json"
MAX=3
LOG=".agents/review-periodic.log"

echo "===== $(date '+%F %T') =====" >> "$LOG"

# 1. 变化监测（新增/更新条目输出）
CHANGES=$(python3 scripts/agent-review.py --repo "$REPO" scan --state "$STATE" 2>&1)
echo "[scan] $CHANGES" >> "$LOG"
echo "$CHANGES"

# 2. 逐条认领：未满员且未认领的 PR/issue 自动认领（重要关联豁免在后续人工判断）
#    认领前先 status 看认领数；认领失败的条目跳过（脚本自带防重/满员判断）。
python3 scripts/agent-review.py --repo "$REPO" status --detail 2>/dev/null | grep -E "^\s*#|PR|Issue" | while IFS= read -r line; do
  num=$(echo "$line" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
  [ -z "$num" ] && continue
  if echo "$line" | grep -qE "已满|claimed|认领"; then continue; fi
  GITHUB_USER=psenY python3 scripts/agent-review.py --repo "$REPO" claim "$num" --user psenY --max "$MAX" >> "$LOG" 2>&1
done
echo "[done]" >> "$LOG"
