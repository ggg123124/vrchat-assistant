#!/usr/bin/env bash
# 部署后容器验证：健康检查 + 新构建 + 新路由 + 全端点探针
# 用法: bash scripts/verify-container.sh [baseUrl]
set -u
cd "$(dirname "$0")/.."
BASE="${1:-http://172.18.0.2:8799}"
TOKEN=""
[ -f .env ] && TOKEN=$(grep -E "^VRC_MONITOR_AUTH_TOKEN=" .env | cut -d= -f2- | tr -d '\r\n')

echo "===== 容器验证: $BASE ====="
python3 - "$BASE" "$TOKEN" <<'EOF'
import urllib.request, json, sys, re
base, token = sys.argv[1], sys.argv[2]
def get(path, timeout=20, method='GET', body=None):
    req = urllib.request.Request(base + path, method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()

ok = fail = 0
def check(name, cond, detail=""):
    global ok, fail
    print(f"{'✓' if cond else '✗'} {name} {detail}")
    if cond: ok += 1
    else: fail += 1

# 1. 健康
st, b = get("/health")
d = json.loads(b) if 200 <= st < 300 else {}
check("health", st == 200, f"auth={d.get('auth',{}).get('authenticated')} ws={d.get('ws',{}).get('status')} plugins={len(d.get('plugins',[]))}")
check("插件 11 个", len(d.get('plugins', [])) == 11, str([p.get('name') for p in d.get('plugins', [])][:5]) + "...")

# 2. 新构建 dashboard（旧构建 ~1,301,456B，新构建 ~1,333,900B）
st, b = get("/dashboard")
check("dashboard 新构建", st == 200 and len(b) > 1330000, f"{len(b)}B")

# 3. 新路由（本轮扩展：覆盖全部 dashboard 功能路由，缓存命中应毫秒级）
for rp in [
    "/api/dashboard/tracked?limit=200",
    "/api/dashboard/tracked-changes?userId=usr_17f80096-b180-4f44-aae7-e8db9e4a7&limit=5",
    "/api/dashboard/weekly-report?days=7",
    "/api/dashboard/x-worlds?limit=5",
    "/api/dashboard/recommend-worlds?theme=default",
    "/api/dashboard/my-groups",
    "/api/dashboard/community-events?window=week",
    "/api/dashboard/watchlist",
    "/api/dashboard/favorites?type=worlds&limit=5",
    "/api/dashboard/recent-worlds?limit=5",
    "/api/dashboard/stats?days=7",
    "/api/dashboard/activity-heatmap?days=7",
    "/api/dashboard/ops-log?limit=5",
    "/api/dashboard/search?q=cat&type=avatars&limit=5",
    "/api/dashboard/prints?limit=5",
    "/api/dashboard/gallery?limit=5",
    "/api/dashboard/group-announcements-all?limit=5",
    "/api/dashboard/booth-search?q=avatar&limit=5",
    "/api/dashboard/booth-searches?limit=5",
    "/api/dashboard/booth-item?itemId=7657840",
]:
    st, b = get(rp, timeout=70)
    check(rp.split("?")[0], st == 200, f"{len(b)}B")
st, b = get("/api/dashboard/moderation/delete", method='POST', body={})
check("moderation/delete 校验", st == 200 and b'bad-params' in b, str(b[:60]))
st, b = get("/api/dashboard/player-list")
check("player-list", st == 200)
st, b = get("/api/dashboard/avatars?limit=5")
check("avatars", st == 200 and b'avatarId' in b, "含 avatarId 字段")

# 4. 全端点探针
print("\n--- dashboard-probe ---")
EOF
TOKEN_BAK="$TOKEN" DASHBOARD_URL="$BASE" VRC_MONITOR_AUTH_TOKEN="$TOKEN" node scripts/dashboard-probe.mjs 2>&1 | tail -20
