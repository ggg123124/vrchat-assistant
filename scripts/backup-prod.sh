#!/usr/bin/env bash
# 生产数据库备份（每次可能影响数据的操作前执行）
# 方式：调用容器 MCP 的 backup_database 工具（better-sqlite3 WAL 在线备份，一致性保证）
# 落盘：容器 /app/data/backups = 路由器 /opt/vrchat-assistant/data/backups
# 轮换：保留最近 10 份（KEEP=10 可调）
set -u
cd "$(dirname "$0")/.."
KEEP="${KEEP:-10}"
BASE="${PROD_BASE:-http://172.18.0.2:8799}"
TOKEN=$(grep -E "^VRC_MONITOR_AUTH_TOKEN=" .env 2>/dev/null | cut -d= -f2- | tr -d '\r\n')

echo "===== $(date '+%F %T') 生产数据库备份 ====="
# 1. MCP 在线备份
REQ='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"backup_database","arguments":{}}}'
RESP=$(python3 - "$BASE" "$TOKEN" "$REQ" <<'EOF'
import urllib.request, json, sys
base, token, req = sys.argv[1], sys.argv[2], sys.argv[3]
r = urllib.request.Request(base + "/mcp", data=req.encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
try:
    with urllib.request.urlopen(r, timeout=60) as resp:
        body = resp.read().decode()
    # MCP over SSE：响应形如 "event: message\ndata: {json}\n\n"，取 data: 后的 JSON 帧
    for line in body.splitlines():
        if line.startswith("data: "):
            payload = line[6:]
            if '"jsonrpc"' in payload:
                print(payload)
                break
    else:
        print(json.dumps({"err": "未找到 SSE data 帧", "raw": body[:200]}))
except Exception as e:
    print(json.dumps({"err": str(e)}))
EOF
)
echo "MCP 响应: $RESP"
FILE=$(echo "$RESP" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    txt = d.get('result',{}).get('content',[{}])[0].get('text','')
    # 工具返回形如 {'path': '/app/data/backups/xxx.sqlite3', ...}
    if txt:
        j = json.loads(txt)
        print(j.get('path',''))
except Exception as e:
    print('')
")
if [ -z "$FILE" ]; then echo "❌ 备份失败（未取到文件路径）"; exit 1; fi

# 2. 路由器侧验证 + 归档（MCP 工具自身只保留 2 份，这里额外归档一份独立历史，保留 KEEP 份）
RKEEP=$((KEEP))
ssh -i ~/.ssh/router_dsh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o IdentitiesOnly=yes root@192.168.100.1 "
F='$FILE'
echo \"容器内备份文件: \$F\"
HOSTF=\"/opt/vrchat-assistant/data/backups/\$(basename \$F)\"
if [ -f \"\$HOSTF\" ]; then
  ls -l \"\$HOSTF\" | awk '{print \"✅ 备份已落盘:\", \$5, \"bytes\", \$9}'
  # 归档：复制到独立目录（带日期后缀），绕开 MCP 工具自身只保留 2 份的限制
  mkdir -p /opt/vrchat-assistant/data/backups-archive
  ARCH=\"/opt/vrchat-assistant/data/backups-archive/\$(basename \$F .sqlite3)-\$(date +%Y%m%d-%H%M%S).sqlite3\"
  cp \"\$HOSTF\" \"\$ARCH\" && echo \"✅ 已归档: \$(basename \$ARCH)\"
  # 归档轮换：保留最近 ${RKEEP} 份（数值已内联）
  ls -1t /opt/vrchat-assistant/data/backups-archive/*.sqlite3 2>/dev/null | tail -n +$((RKEEP + 1)) | xargs -r rm -f
  echo \"归档总数: \$(ls -1 /opt/vrchat-assistant/data/backups-archive/*.sqlite3 2>/dev/null | wc -l)\"
  # 自验证：SQLite 魔数头 + 大小（归档由 MCP better-sqlite3 backup() 一致生成，主要风险是复制损坏）
  if head -c 16 \"\$ARCH\" 2>/dev/null | grep -q \"SQLite format 3\"; then
    echo \"🧪 归档自验证: 魔数头 OK · \$(stat -c %s \"\$ARCH\") bytes\"
  else
    echo \"❌ 归档自验证失败：魔数头不匹配（文件可能损坏）\"
  fi
else
  echo '❌ 未在宿主机找到备份文件'
fi
" 2>&1 | grep -v "Warning: Permanently"
echo "===== 备份完成 ====="
