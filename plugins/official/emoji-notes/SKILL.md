# emoji-notes 插件（Skill 文档）

## 用途

给自定义 / 内置 boop emoji 存**个性化备注/别名**（本地 sqlite 个人数据），并把**可能带中文 STT 噪声的口语描述**（如「狐狸检查PR」「弧狸检查PR」「审核PR那个」「大笑」）鲁棒反查成 `emojiId`，再交给 `send_boop` 执行。解决「每次都要追问用户是哪个 fileId」的痛点。

提供三个 MCP 工具：`set_emoji_note`（写·本地）/ `get_emoji_notes`（查）/ `resolve_emoji`（检索）。

## 工具用法

### 1. 给表情设备注/别名（一次成本，之后语音检索永久生效）

```
set_emoji_note { emojiId: "file_xxx", note: "狐狸在检查 PR 的图",
                 aliases: ["狐狸检查PR", "审核PR", "狐狸"], tags: ["审核"], category: "梗图" }
```

- 内置表情 `emojiId` 形如 `default_laugh`（见 `get_boop_emojis`）；自定义表情用 `upload_emoji` 返回的 fileId。
- 别名是「整表替换」语义；`note` 与 `aliases` 都为空时软删除该条。
- 防御上限：note ≤ 2000 字符、aliases ≤ 50 个、单别名 ≤ 100 字符。

### 2. 查询备注

```
get_emoji_notes {}                        # 全部有效备注（默认 100 条）
get_emoji_notes { emojiId: "file_xxx" }   # 精确查单条
get_emoji_notes { kind: "custom" }        # 只查自定义
get_emoji_notes { includeDeleted: true }  # 含软删除项
```

### 3. 口语描述反查 emojiId（resolve → send_boop 链路）

```
resolve_emoji { query: "狐狸检查PR" }
# matched=true → { emojiId: "file_xxx", confidence: 1.0, matchedBy: "alias", ... }
# 然后：
send_boop { userId: "usr_xxx", emojiId: "file_xxx" }

resolve_emoji { query: "大笑" }    # 无备注也能命中内置 default_laugh（builtin_zh）
resolve_emoji { query: "laugh" }   # 内置英文名（builtin_en）
resolve_emoji { query: "弧狸检查PR" }  # STT 同音错字 → 拼音同音命中（pinyin, 0.95）
```

匹配信号（`matchedBy`）：`alias` / `pinyin` / `token_overlap` / `fuzzy_pinyin` / `fuzzy_hanzi` / `builtin_zh` / `builtin_en`。

## 纪律：先 resolve 拿 emojiId，歧义必须反问用户

1. **写路径不猜**：`send_boop` 只收 `emojiId`；任何「用户口述描述」都要先走 `resolve_emoji`。
2. **歧义必须反问**：`resolve_emoji` 返回 `needsClarification=true`（或 `matched=false`）时，**绝不擅自选用第一名候选**，必须把 `candidates`（降序，带 `confidence` 和 `matchedBy`）展示给用户确认：「你是说『狐狸检查PR』那张，还是『狐狸吃鸡』那张？」
3. **未备注的自定义表情无法靠文字命中**：resolve 无候选时，引导用户 `set_emoji_note` 补一句备注/别名（一次性），不要反复问 fileId。
4. 判定规则（`resolve.js` 顶部常量）：`top.confidence ≥ 0.85` 且 `top - second ≥ 0.2` 才唯一命中；否则返回候选。

## 依赖

- 唯一运行时依赖 `pinyin-pro`（纯 JS 拼音库，无 native 编译）。插件自带 `package.json` 声明依赖。
- 若启动报「缺少依赖 pinyin-pro」，执行：

```
npm ci --prefix plugins/official/emoji-notes
```

## 内置清单（同源维护说明）

`builtin-emojis.js` 的 65 个内置表情 + 中文别名与 `plugins/official/media/index.js` 的 `categories` **同源维护**：VRChat 增减内置 boop 表情时，**两处必须同步修改**（单一权威源抽共享模块之前，改一处必须检查另一处）。用户给内置表情（`default_xxx`）加的 DB 备注优先于静态中文别名。
