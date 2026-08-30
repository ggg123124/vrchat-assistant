---
name: openwrt-public-exposure
description: 把 OpenWrt/iStoreOS 路由器服务安全暴露公网（Lucky 转发/Cloudflare 排障）。
metadata:
  hermes:
    tags: [openwrt, router, network, deployment]
---

# OpenWrt/iStoreOS 服务公网安全暴露

用户的长期环境：OpenWrt/iStoreOS 路由器 `192.168.100.1`（root SSH），**Lucky**（`/usr/bin/lucky`，面板 `:16601`，配置目录 `/etc/config/lucky.daji/`）做端口转发/反代；域名 **psen.cc 套了 Cloudflare CDN**；SSH 为 dropbear（监听 22）。

## 铁律：暴露前先加固认证（已验证顺序）

SSH 暴露公网**必须**先改密钥认证，否则公网扫描器秒级爆破 root 密码。顺序（防锁死）：
1. 把公钥追加进 `/etc/dropbear/authorized_keys`（root 用此路径；`chmod 600`；每行一个公钥）
2. **先用密钥验证能登录**（paramiko `pkey=` 或 `ssh -i`），此时不改 dropbear——验证失败也能回退
3. 验证通过后才关密码：`uci set dropbear.main.PasswordAuth='off'; uci set dropbear.main.RootPasswordAuth='off'; uci commit dropbear; /etc/init.d/dropbear restart`
4. 重启后复验：密钥能连、密码被拒（`paramiko.AuthenticationException`）

已验证：此流程在 192.168.100.1 成功，公钥来自服务器 `~/.ssh/id_ed25519` 与用户 Windows 电脑（`campusnet`）。

## Lucky 端口转发（已验证可用）

- Lucky 配置 lkcf 是**加密二进制**，不能直接改文件——只能通过**面板**（http://192.168.100.1:16601）或内部 API 配置；面板 API 常规路径 404，无文档不要硬猜
- 加"端口转发"：监听 `0.0.0.0:<公网端口>` → 目标 `127.0.0.1:22`，协议 TCP
- Lucky 会自监听该端口（`netstat` 可见），并自动集成防火墙（`nft list ruleset` 里出现 `tcp dport <端口> accept`）
- 验证转发通：`nc -w 3 127.0.0.1 <端口>` 应返回 `SSH-2.0-dropbear` banner；再找一台**独立公网出口**的机器直连公网 IP:端口验证（不要只在路由器本机测）

## Cloudflare 不转发 TCP（已验证铁律）

域名套 Cloudflare CDN（橙色云）后**只代理 80/443**，任意 TCP 端口（SSH 2222/22）到 Cloudflare 边缘即丢弃→超时。现象：`域名:443` 通、`域名:2222` 超时，但**公网 IP 直连同端口通**（`getaddrinfo` 见解析到 104.21.x/172.67.x 即 Cloudflare IP 段）。

解法：SSH 用**独立子域名**（如 `ssh.psen.cc`）在 Cloudflare 加 **A 记录指向真实公网 IP、代理状态"仅 DNS/灰云"**（不要开橙色云），然后 `ssh -p <端口> root@ssh.psen.cc`。

## 排障路径

1. 路由器：`netstat -tlnp | grep lucky`（确认监听）→ `nc 127.0.0.1 <端口>`（确认转发目标）
2. 防火墙：`nft list ruleset | grep <端口>`
3. 公网：独立出口机器 python socket 连 `公网IP:<端口>` 收 banner
4. 域名：`python socket.getaddrinfo` 看解析 IP——是 Cloudflare 段还是真实 IP；逐个 IP 测端口
5. 注意公网 22 可能早被旧映射暴露（直连 IP:22 有 banner）——确认没用的旧映射关闭，只留加固后的 2222

## 参考
- `references/windows-ci-python-encoding.md` — Python 脚本在 Windows CI 的 cp1252 输出编码坑（本项目 CI 曾因此失败）
