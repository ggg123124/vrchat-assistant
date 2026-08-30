#!/usr/bin/env bash
# 路由器部署脚本（scp+ssh 版，无需 paramiko）
# 用法: bash deploy.sh [--skip-build]   （--skip-build 只同步代码不重建容器）
set -u
cd "$(dirname "$0")"
ROUTER="${VRC_DEPLOY_HOST:-192.168.100.1}"
SSH_USER="${VRC_DEPLOY_USER:-root}"
KEY="${VRC_DEPLOY_KEY:-$HOME/.ssh/router_dsh}"
REMOTE_DIR="/opt/vrchat-assistant"
SSH_OPTS="-i $KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o IdentitiesOnly=yes"

if [ ! -f "$KEY" ]; then echo "❌ 密钥不存在: $KEY"; exit 1; fi
if ! ssh $SSH_OPTS "$SSH_USER@$ROUTER" 'echo SSH-OK' >/dev/null 2>&1; then
  echo "❌ SSH 连接失败（$ROUTER）——请先确认公钥已加入 /etc/dropbear/authorized_keys"
  exit 1
fi
echo "✅ SSH 连接成功: $ROUTER"

# ── 0. 部署前快照（记录远端现状，便于回滚/核对） ──
echo "── 0. 远端现状快照 ──"
ssh $SSH_OPTS "$SSH_USER@$ROUTER" "cd $REMOTE_DIR && echo 'git:'; git log --oneline -2 2>/dev/null; echo 'status:'; git status -s 2>/dev/null | head -5; echo 'docker:'; docker ps --filter name=vrchat-assistant --format '{{.Names}} {{.Status}}'; echo 'data:'; du -sh data 2>/dev/null"

# ── 1. 打包本地代码（排除敏感/运行时/构建缓存） ──
echo "── 1. 打包本地代码 ──"
TARBALL="/tmp/vrchat-assistant-deploy.tar.gz"
tar -czf "$TARBALL" \
  --exclude='.git' --exclude='node_modules' --exclude='data' --exclude='backups' \
  --exclude='__pycache__' --exclude='.system_generated' --exclude='service-logs' \
  --exclude='.env' --exclude='credentials.json' --exclude='auth_cookie.txt' \
  --exclude='notify-config.json' --exclude='*.sqlite3*' --exclude='*.pub' \
  --exclude='router_dsh' --exclude='id_ed25519*' \
  . 2>/dev/null
echo "打包完成: $(du -h "$TARBALL" | cut -f1)"

# ── 2. 上传 + 解压 ──
echo "── 2. 上传并解压到 $REMOTE_DIR ──"
scp $SSH_OPTS "$TARBALL" "$SSH_USER@$ROUTER:/opt/code_update.tar.gz" >/dev/null 2>&1 || { echo "❌ 上传失败"; rm -f "$TARBALL"; exit 1; }
ssh $SSH_OPTS "$SSH_USER@$ROUTER" "mkdir -p $REMOTE_DIR && tar -xzf /opt/code_update.tar.gz -C $REMOTE_DIR && rm /opt/code_update.tar.gz" || { echo "❌ 解压失败"; rm -f "$TARBALL"; exit 1; }
rm -f "$TARBALL"
echo "✅ 代码已同步"

# ── 3. 重建容器（默认；--skip-build 跳过） ──
if [ "${1:-}" != "--skip-build" ]; then
  echo "── 3. 重建容器（docker compose） ──"
  ssh $SSH_OPTS "$SSH_USER@$ROUTER" "cd $REMOTE_DIR && (docker compose up -d --build 2>&1 || docker-compose up -d --build 2>&1)" | tail -15
else
  echo "── 3. 跳过容器重建（--skip-build） ──"
fi

# ── 4. 验证 ──
echo "── 4. 容器状态与日志 ──"
ssh $SSH_OPTS "$SSH_USER@$ROUTER" "docker ps --filter name=vrchat-assistant --format '{{.Names}} {{.Status}}'; echo '---最近日志---'; docker logs --tail 15 vrchat-assistant 2>&1 | tail -15"
echo ""
echo "部署完成。浏览器验证: http://$ROUTER:8799/dashboard"
