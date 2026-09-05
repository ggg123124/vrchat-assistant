# friend-removals 插件 — 谁把我删了

**触发场景**：用户问「谁删除我了」「XX 是不是把我删了」「有谁把我从好友列表移除了」。

## 机制

VRChat 对方解除与你的好友关系时，你的 WebSocket 会收到 `friend-delete` 事件，核心事件流实时落库 `events` 表（`type='friend-delete'`），并把该好友自动移出本地 `friends` 表。**该事件是「对方主动删你」的信号，不是你自己删人**（主动删人走 `remove_friend` 工具，无此事件）。

## 工具

| 工具 | 说明 |
|------|------|
| `get_friend_removals` | 列出历史上把你删掉的人与解除时间。`userId` 省略=全部；`days`=只看最近 N 天；`limit/offset` 分页。每条含 `userId`/`displayName`（尽力回填其最后使用名）/`nickname`（本地昵称）/`createdAt`（解除时刻 UTC） |

### 使用示例

```
「谁删除我了？」          → get_friend_removals()
「最近一周谁删了我？」    → get_friend_removals({ days: 7 })
「云白雪浅° 什么时候删的」→ get_friend_removals({ userId: "usr_..." })（也可先 search_users 解析名字）
```

### 注意事项

- **显示名回填**：friend-delete 事件本身不带对方名字（解除后 VRChat 不再下发），插件经 `get_friend_events` 回溯该 userId 历史最近一次带名事件；若全程匿名则 `displayName` 为空串，需结合 userId 判断。
- **数据源口径**：仅记录本服务上线期间收到的 friend-delete；本服务未运行时对方删除无法捕获（WS 未连接）。
- 依赖核心 `get_recent_events` 的 SQL 层类型过滤（2026-09-06 修复），早期版本该工具查不到 friend-delete 历史。
