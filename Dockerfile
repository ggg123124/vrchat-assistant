# ── 前端构建阶段（issue #186 方案 A：ui/dist 不入库，镜像内构建；工具链不进 runtime）──
FROM node:22-slim AS ui-builder
WORKDIR /app
COPY plugins/official/web-dashboard/ui/package*.json ./plugins/official/web-dashboard/ui/
RUN npm ci --prefix plugins/official/web-dashboard/ui
COPY plugins/official/web-dashboard/ui ./plugins/official/web-dashboard/ui
RUN npm run build --prefix plugins/official/web-dashboard/ui

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
# 前端产物：dist 已出库（.dockerignore 排除），以 builder 阶段产物为准（防「源码有功能、产物没有」）
COPY --from=ui-builder /app/plugins/official/web-dashboard/ui/dist ./plugins/official/web-dashboard/ui/dist

RUN mkdir -p /app/data /app/backups

ENV NODE_ENV=production VRC_MONITOR_HOST=0.0.0.0 VRC_MONITOR_PORT=8799 VRC_MONITOR_DB_PATH=/app/data/vrc-monitor.sqlite3 VRC_MONITOR_BACKUP_DIR=/app/backups

EXPOSE 8799

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.VRC_MONITOR_PORT || '8799') + '/health', { headers: process.env.VRC_MONITOR_AUTH_TOKEN ? { 'Authorization': 'Bearer ' + process.env.VRC_MONITOR_AUTH_TOKEN } : {} }).then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "start-monitor.js"]
