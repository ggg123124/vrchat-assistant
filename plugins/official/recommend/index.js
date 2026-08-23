export default function register(api) {
  api.registerTool({
    name: "get_favorite_friends_locations",
    description: "[query·好友收藏] 列出某个好友收藏夹（线上收藏分组）内所有好友的当前位置列表。可指定 groupName（如 \"new\"、\"join\" 等收藏夹名）或 favoriteGroupId；不指定则列出全部分组。返回按推荐度排序：在线且实例可加入的在前（public/friends/hidden=friend+/group 实例均可加入），仅 private 实例自动排除（看不到位置），按实例内玩家数/容量比 + 收藏热度综合评分。也可用 searchName 直接按名字在好友列表里查某人的位置（能看到具体位置即代表可加入，标记 joinable；纯 private 才进不去）。",
    inputSchema: {
  "type": "object",
  "properties": {
    "groupName": {
      "type": "string",
      "description": "收藏夹名（displayName），如 \"new\"/\"join\"。不填则返回全部分组概览"
    },
    "favoriteGroupId": {
      "type": "string",
      "description": "收藏分组 id（fvgrp_...），与 groupName 二选一"
    },
    "searchName": {
      "type": "string",
      "description": "按名字（模糊匹配，不区分大小写）在好友列表里直接查某人位置，返回单人或多人结果。与 groupName/favoriteGroupId 互斥"
    }
  }
},
    handler: async (args) => api.consume("recommend.favoriteFriendsLocations", args)
  });

  api.registerTool({
    name: "recommend_join",
    description: "[query·推荐加入] 查看全部在线好友在做什么，按推荐度排序给出可加入的推荐。综合评分：熟悉度（最近30天+历史一年共玩次数，来自本地 events 同屏统计）+ 收藏夹分组权重（可配置）+ 房间场景（睡觉图人少=电灯泡风险降权）+ 实例人数/容量比 + 实例类型（public/friends/friend+/group 可加入，private 排除）。返回 TopN 推荐及理由。",
    inputSchema: {
  "type": "object",
  "properties": {
    "limit": {
      "type": "number",
      "default": 10,
      "description": "返回数量（默认 10）"
    },
    "minScore": {
      "type": "number",
      "default": 0,
      "description": "最低推荐分过滤（默认 0，负分=电灯泡/联系人风险）"
    }
  }
},
    handler: async (args) => api.consume("recommend.recommendJoin", args)
  });

  api.registerTool({
    name: "set_join_preference",
    description: "[配置·推荐偏好] 用自然语言设置「推荐加入」的评分偏好，持久化到 config 表，下次推荐自动生效。例：「我不喜欢人太多」→ 爆满惩罚加重(80)、人数权重降低(×1.5)、冷清不罚；「喜欢热闹」→ 人数权重加强(×4)、爆满轻罚(20)；「恢复默认」→ 清除偏好。",
    inputSchema: {
  "type": "object",
  "properties": {
    "preference": {
      "type": "string",
      "description": "自然语言偏好，如「我不喜欢人太多」「喜欢热闹」「恢复默认」"
    }
  },
  "required": [
    "preference"
  ]
},
    handler: async (args) => api.consume("recommend.setJoinPreference", args)
  });

  api.registerTool({
    name: "get_join_preference",
    description: "[配置·推荐偏好] 查询当前「推荐加入」的评分偏好（含解析结果与设置时间）。",
    inputSchema: {
  "type": "object",
  "properties": {}
},
    handler: async (args) => api.consume("recommend.getJoinPreference", args)
  });

  api.registerTool({
    name: "record_join_choice",
    description: "[配置·选择学习] 记录一次「从推荐列表中选择加入」的行为（用户选择谁/哪张图）。服务端自动从最近一次 recommend_join 的快照补全上下文（人数/类型/熟悉度/排名/列表基线），写入 join_choices 表；积累 ≥5 次后自动分析用户偏好（选人少→避人潮、总选熟人→熟悉度加权等）并应用到推荐权重。用法：先运行 recommend_join 拉列表，再从列表里选一个人记录：传 userId 或 displayName（模糊匹配）。",
    inputSchema: {
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "description": "被选择好友的 userId（usr_...）"
    },
    "displayName": {
      "type": "string",
      "description": "被选择好友的显示名（模糊匹配，与 userId 二选一）"
    }
  }
},
    handler: async (args) => api.consume("recommend.recordJoinChoice", args)
  });

  api.registerTool({
    name: "get_join_learning",
    description: "[配置·选择学习] 查看推荐选择学习状态：累计选择数、自动分析出的偏好（人数倾向/熟悉度加权/安静图倾向）与生效中的权重调整。",
    inputSchema: {
  "type": "object",
  "properties": {}
},
    handler: async (args) => api.consume("recommend.getJoinLearning", args)
  });

  api.registerTool({
    name: "recommend_worlds",
    description: "[query·推荐] Multi-source world recommendation: fuses local world_kb + PlanetVRC popularity ranking + official theme search, scored by heat × user feedback × freshness × theme match × author affinity. Returns scored candidates with explainable reasons and canOpen flag (planet cards are resolved to wrld_ ids via official name lookup).",
    inputSchema: {
  "type": "object",
  "properties": {
    "theme": {
      "type": "string",
      "enum": [
        "sleep",
        "chat",
        "onsen",
        "game",
        "default"
      ],
      "default": "default",
      "description": "Theme to boost (sleep boosts sleep_ok worlds strongly; other themes boost keyword matches)"
    },
    "excludeTheme": {
      "type": "string",
      "description": "Comma-separated themes to exclude (matched against author_tag_* and name/description keywords, e.g. \"game,horror\")"
    },
    "limit": {
      "type": "number",
      "default": 5,
      "description": "Max results (1-10, default 5)"
    },
    "sources": {
      "type": "string",
      "default": "local,planet",
      "description": "Comma-separated sources: local (world_kb table), planet (PlanetVRC ranking), official (theme keyword search)"
    },
    "excludeVisited": {
      "type": "boolean",
      "default": true,
      "description": "Skip worlds already visited"
    },
    "detail": {
      "type": "boolean",
      "default": true,
      "description": "Enrich description/imageUrl/note from world_cache"
    }
  }
},
    handler: async (args) => api.consume("recommend.recommendWorlds", args)
  });

}
