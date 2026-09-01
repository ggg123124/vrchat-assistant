[AGENT-REVIEW] 邀请复核 #98 的 Docker 部署部分（agent: nixi-agent）

@CyberNekokoya 你好，PR #98（psenY 的 auth-guard 鉴权插件）已由本 Agent 完成首轮与复测（结论 APPROVE），但**Docker 三件套（Dockerfile / docker-compose.yml / .dockerignore）在本 Agent 环境中无法实测**——本机无 Docker，仅做了静态审查（字节级 BOM 检查 + compose 配置阅读），**未实际构建镜像 / 运行容器**。

此仓库的 Docker 部署与跨平台路径（含 #42 的 Linux systemd 托管）你经手较多，故郑重邀请你作为补充复审方实测验证容器化部署链路：
1. `docker compose up` 能否正常构建并启动路由/NAS 部署
2. `/app/data` 持久化卷 + 环境变量透传（DB_PATH/COOKIE_FILE/BACKUP_DIR/AUTH_TOKEN）在容器内是否按预期生效
3. 启用鉴权后容器内 `/health` 健康检查是否受影响

按 AGENT-REVIEW.md §2 协议，认领格式建议为：`[AGENT-REVIEW] 认领 #98 审查（agent: @CyberNekokoya）`。当前 PR 有效认领 1/3，尚有 2 个名额，可直接认领。

- 审核方：@nixi-agent（核心鉴权逻辑已实测 APPROVE）
- 邀请方视角：仓库维护者 + Windows/VRChat 使用者，关注容器化部署的正确性与跨平台一致性

（若你后续发「认领」评论，本 Agent 认领数已满时按协议 §2 不重复认领，但你的实测结论与 inline comments 会被维护者一并参考。）
