# presence-status —— 按「自己是否在游戏内」自动切换自定义状态文字

> 本文档给调用本插件的 AI Agent 看：这个插件能做什么、怎么用。

## 为什么需要它

本服务常驻登录 VRChat 账号（云服务器 24h 在线）时，自己在好友眼里长期是
**"在网站上活跃"**（位置 `offline:offline`）。使用者要求：

- **不在游戏内**（挂机，服务还开着）→ 状态文字显示"挂机"提示（如 `Bot挂机`）；
- **回到游戏内** → **恢复成上次下线时的那条状态文字**（不是写死一套固定文案）。

核心的动态状态引擎（`get_dynamic_status` / `set_dynamic_status`）只支持 `{online}`
（在线好友数）一个变量，无法区分"自己是否在游戏里"；本插件补上这个能力。

## 能力

- **get_presence_status**：查询配置、核心自我在场判定（`in_game` / `not_in_game` / `unknown`）、
  已捕获的"上次下线时状态" `savedText`、最近一次写入与错误。
- **set_presence_status**：设置开关、挂机文案、轮询间隔、恢复用文字；可 `syncNow` 立即同步一次。

配置项（存插件私有表 `plg_presence-status_settings`，跨重启保留）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否启用自动切换（默认关闭，需显式开启） |
| `idleTemplate` | `挂机中（服务在线）` | **不在游戏内**时写入的状态文字（≤64 字符） |
| `pollSeconds` | `60` | 轮询间隔秒（下限 20，上限 3600） |
| `savedText` | （自动捕获） | **回到游戏内时要恢复的文字**。出游戏时自动捕获当前文案；也可手动指定（空串=清空，回到游戏后不改文字） |

## 工作方式：捕获 + 恢复（转换点触发）

```
在游戏内 ──检测到出游戏──▶ ① 读当前状态文字并捕获为 savedText（= 你上次下线的状态）
                          ② 写入 idleTemplate（如 Bot挂机）
不在游戏 ──检测到进游戏──▶ 写回 savedText
```

- **只在转换点动作**：进/出游戏各触发一次，之后不反复改写——你在别处手动改的状态文字会被保留
  （不会被每次轮询抢回去）。
- **判定源**：核心服务 `dashboard.selfPresence` 的三态（见 `core/self-presence.js`）。
- **不确定就不动**：`unknown`（无位置记录 / 位置陈旧超 1 小时 / 解析失败）时不翻转现状。
- **没有可恢复值时保护现状**：`savedText` 为空（或恰好等于 `idleTemplate`）时回到游戏内——
  若当前文案是**你自己写的**（非空、且不是本插件写入的挂机文案），**保持不动**并把它记为新的基线；
  只有当现状已为空、或现状正是本插件写入的挂机文案时，才写入空串（避免把挂机文案留在"人在游戏里"的状态上）。
- **只改状态文字**（`statusDescription`），`status` 种类原样回传，**不改变在线形态**。
- **与动态状态引擎互斥**：核心 `set_dynamic_status`（按在线好友数改状态文字）与本插件写的是**同一个**
  `statusDescription`，代码里互不知情——两者同时启用时，挂机期间好友上下线会把挂机文案覆盖成"在线 N 人"，
  回到游戏时本插件再写回捕获值，挂机提示因此不可靠。**建议只启用其一**（两个工具的 description 里也有同样提醒）。
- **防抖**：两次 PUT 之间最小间隔 65 秒（与核心动态状态引擎同阈值）；目标文案已在位时不重复提交；
  重启后从插件表恢复 `lastState`/`savedText`，不会因重启重复动作。
- **延迟**：插件契约 v1.3 的 8 个 API 面没有事件订阅能力，因此按 `pollSeconds` 轮询（默认 60s）
  ——**进游戏**方向最坏延迟约等于轮询间隔；**出游戏**方向还要先过核心的出游戏确认窗口
  （`core/self-presence.js` 的 `VRC_MONITOR_SELF_PRESENCE_OFFLINE_GRACE_SECONDS`，默认 360s；窗口内一律判 `unknown`、
  本插件据此跳过写入），故最坏延迟 ≈ 轮询间隔 + 确认窗口（默认约 420s）。轮询只查本地 SQL（不产生 VRChat API 调用），
  每个转换点最多 2 次 API 调用（`/auth/user` + `PUT /users/{id}`）。

## 用法

```
set_presence_status { "enabled": true, "idleTemplate": "Bot挂机" }
get_presence_status
```

返回（`get_presence_status` 节选）：

```json
{
  "config": { "enabled": true, "idleTemplate": "Bot挂机", "pollSeconds": 60 },
  "presence": { "state": "not_in_game", "location": "offline:offline", "at": "2026-09-17T10:00:13.422Z" },
  "savedText": "看番中",
  "lastState": "not_in_game",
  "lastText": "Bot挂机",
  "serviceAvailable": true
}
```

## 依赖

- 核心服务 `dashboard.selfPresence`（三态自我在场判定，见 `core/self-presence.js`）；
  缺该服务时工具仍可查询配置，但同步动作会返回 `reason: "no-self-presence-service"`。
