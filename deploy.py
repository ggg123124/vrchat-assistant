#!/usr/bin/env python3
# 路由器远程部署脚本（SSH 密钥优先版）
# 用法:
#   python3 deploy.py                      # 用 ~/.ssh/router_dsh 密钥（推荐）
#   VRC_DEPLOY_SSH_PASS=xxx python3 deploy.py   # 或环境变量密码（密钥不可用时）
import io
import os
import sys
import tarfile
import paramiko

# ── 1. 连接路由器 ──
ROUTER_IP = os.environ.get('VRC_DEPLOY_HOST', '192.168.100.1')
SSH_USER = os.environ.get('VRC_DEPLOY_USER', 'root')
KEY_PATH = os.path.expanduser(os.environ.get('VRC_DEPLOY_KEY', '~/.ssh/router_dsh'))
SSH_PASS = os.environ.get('VRC_DEPLOY_SSH_PASS', '')   # 密码不再硬编码（2026-08-30 去除）
REMOTE_DIR = '/opt/vrchat-assistant'
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
print(f'正在连接路由器 {ROUTER_IP}（用户 {SSH_USER}）...')

if os.path.exists(KEY_PATH):
    print(f'使用 SSH 密钥: {KEY_PATH}')
    ssh.connect(ROUTER_IP, port=22, username=SSH_USER, key_filename=KEY_PATH, timeout=15)
elif SSH_PASS:
    print('使用环境变量密码认证')
    ssh.connect(ROUTER_IP, port=22, username=SSH_USER, password=SSH_PASS, timeout=15)
else:
    print('错误: 未找到 SSH 密钥（~/.ssh/router_dsh），也未设置 VRC_DEPLOY_SSH_PASS', file=sys.stderr)
    sys.exit(1)

def run(cmd):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=180)
    out = stdout.read().decode('utf-8', errors='ignore').strip()
    err = stderr.read().decode('utf-8', errors='ignore').strip()
    return out, err

# ── 2. 本地内存打包（自动排除无用文件/敏感物） ──
print('1. 正在打包本地代码库...')
tar_buffer = io.BytesIO()
exclude_dirs = {'.git', 'node_modules', 'data', 'backups', '__pycache__', '.system_generated', 'service-logs'}

with tarfile.open(fileobj=tar_buffer, mode='w:gz') as tar:
    for root, dirs, files in os.walk(PROJECT_ROOT):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for f in files:
            # 排除敏感/运行时文件（凭据、cookie、数据库、密钥、日志）
            if f.endswith(('.sqlite3', '.sqlite3-wal', '.sqlite3-shm', '.pyc', '.pub', 'id_ed25519')):
                continue
            if f in ('credentials.json', 'auth_cookie.txt', 'notify-config.json', '.env', '.env.*'):
                continue
            if 'id_ed25519' in f or 'router_dsh' in f:
                continue
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, PROJECT_ROOT)
            tar.add(full_path, arcname=rel_path)

tar_buffer.seek(0)
print(f'打包完成，大小: {len(tar_buffer.getvalue()) / 1024:.1f} KB')

# ── 3. 上传到路由器 ──
print('2. 正在通过 SFTP 上传至路由器...')
sftp = ssh.open_sftp()
with sftp.open('/opt/code_update.tar.gz', 'wb') as f:
    f.write(tar_buffer.read())
sftp.close()
print('上传完成')

# ── 4. 解压并重新构建 Docker 容器（compose v2 优先，兼容 v1） ──
print('3. 正在解压并触发 Docker 重建...')
run(f'mkdir -p {REMOTE_DIR}')
run(f'tar -xzf /opt/code_update.tar.gz -C {REMOTE_DIR} && rm /opt/code_update.tar.gz')
out, err = run(f'cd {REMOTE_DIR} && (docker compose up -d --build 2>/dev/null || docker-compose up -d --build)')
print('Docker 构建结果:')
print(out if out else err)

# ── 5. 检查容器状态 ──
print('\n4. 检查容器运行状态...')
out, err = run('docker ps --filter name=vrchat-assistant --format "{{.Names}}\t{{.Status}}"')
print(out if out else '容器未找到')

# ── 6. 查看最近日志 ──
print('\n5. 查看容器最近日志（最后 20 行）:')
out, err = run('docker logs --tail 20 vrchat-assistant 2>&1')
print(out if out else err)

ssh.close()
print('\n部署完成！')
