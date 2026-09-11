---
name: vrchat-group-queries
description: "VRChat groups: announcements, join/leave/peek."
version: 1.0.0
metadata:
  hermes:
    tags: [vrchat, gaming, groups, queries]
    related_skills: [vrc-monitor-agent]
---

# VRChat 群组域 — 查询与操作

本 skill 覆盖 **vrc-monitor 的群组域**：群组查询、公告读取、403 分诊、加入/退出/窥探。

> ⚠️ **工具表唯一权威在 vrc-monitor-agent skill**。本 skill 只写工作流与域内细节，不复制工具表。通用 MCP 调用陷阱见 vrc-monitor-agent「常见陷阱」。
> MCP 端点：`http://127.0.0.1:8799/mcp`；服务未启动处理见 vrc-monitor-agent「服务健康检查」。

## 1. 群组查询

用户问"XX 群组有没有开房/集会安排/我加了哪些群组"时，直接走群组工具，不要用裸 curl 探测端点：

```
1. get_user_groups() → 我/某人加入了哪些群组（`userId` 可选，省略 = 当前账号；`withDetails: true` 批量带简介）
2. get_group_info(groupId) → 群组详情（成员数/描述/joinState；`includeAnnouncement: true` 附带公告，非成员 null）
3. get_group_instances(groupId) → 群组当前开的房（空 [] = 没开房；返回 worldName/人数）
4. get_group_announcement(groupId) → 群组公告（活动安排/集会日期）
5. get_group_invites() → 账号收到的待处理群组邀请（群名/成员数/描述；**仅自己**——VRChat 对他人邀请一律 403「Not allowed to review invites/requests for other users.」，别按好友 userId 去查）
6. **查群主/创建人**：`get_group_info` **不含 ownerId**——裸 API `GET https://api.vrchat.cloud/api/1/groups/{groupId}`（Cookie: auth=… 从 data/auth_cookie.txt 读，UA 必带）返回完整对象，含 `ownerId`/`createdAt`/`onlineMemberCount`/`rules` 等 MCP 工具没暴露的字段；再 `get_friend_info(ownerId)` 调出群主资料
```

**陷阱：**
- **端点**：`GET /auth/user/groups` → 404 不存在；正确端点是 `GET /users/{userId}/groups`
- **⚠️ 群组搜索 API 参数**：`GET /groups?search=<关键词>` 是**废参数**——返回固定无关列表，完全忽略关键词。正确参数是 **`query`**：`GET /groups?query=<关键词>&n=30`。判断依据：结果是否和关键词相关，无关先怀疑参数名而不是"群不可搜索"
- **可查任意用户**：`get_user_groups` 传别人 userId 一样能查（群组列表默认公开），共同群组可做社交画像
- **`get_group_heat`**：群组房活动热度榜（活动次数/活跃好友/世界数/成员数/趋势）+ topK 群热力图；`grp_`/`gmem_` 兼容

## 2. 群组公告 403 的两种性质

**公告 403 别一看到就当故障，先分性质：**
- **非成员群必 403**（响应体 `You're not a member.`）= VRChat 规则，查非成员群的公告就是拿不到——**正常业务**。想查别人的私人小群公告，提前预期会失败
- **成员群偶发瞬时 403** = 限流/抖动（同 cookie 直连 API 却是 200）。诊断法：urllib 直连 `GET /groups/{id}/announcement`（data/auth_cookie.txt + UA），换 UA 也是 200 → 排除 UA/WAF 因素 → 瞬时抖动，重试即好
- 工具已对 403/404 返回 `{groupId, announcement: null}` 不抛错

## 3. join / leave / peek

**"能提前判断某群能不能直接加入吗？"**：能。`get_group_info` 返回的 `joinState` 就是答案——`open`=直接加入、`request`=需审核、`invite`=仅邀请。

- `join_group {groupId}`：open 群直接加入；**已是成员返回 `alreadyMember:true` 不报错**（400 幂等安全）
- `leave_group {groupId}`：**自己退出用 `POST /groups/{id}/leave`**（`DELETE /members/{userId}` 是管理员移除成员，普通成员 403——实测踩坑）。**必须 `confirm: true`**，否则只返回预览
- `peek_group_announcement {groupId, confirm:true}`：一键「加入→读公告→退出」，**仅对 open 群生效**（request/invite 返回 peekable:false）；必须 confirm 防误触自动加群

**真实写操作测试后的副作用验证**：用户明确授权后可真实执行，但**完成后必须验证副作用已清理**——`get_user_groups` 对比群数确认退出生效。测写操作 = 测完查状态恢复。

**群组定位补充**：用户报的群名先拉 `get_user_groups`（目标用户或自己）按音近/近似匹配（口述群名常被语音识别歪）。**世界关联群组（`GET /worlds/{id}` 的 `groupId` 字段）反查思路实测基本不可用**（多数世界作者没绑群）。别走"世界→群"这条路，直接拉人的群组列表。
