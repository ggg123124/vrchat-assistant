export default function register(api) {
  api.registerTool({
    name: 'x_world_digest',
    description: '[查询·X推荐] 聚合指定 X 博主近 1/3/7/15/30 天推荐的世界，按收藏数排序输出；收藏/浏览比 ≥ 1/5 的标注为 ⭐重点。可选 refresh=true 先抓取最新推文再查询。',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: '时间窗口天数：1/3/7/15/30，默认 7',
          default: 7
        },
        highlightRatio: {
          type: 'number',
          description: '收藏/浏览比标注阈值，默认 0.2（五分之一）',
          default: 0.2
        },
        limit: {
          type: 'number',
          description: '返回条数上限，默认 50',
          default: 50
        },
        creator: {
          type: 'string',
          description: '只显示某博主（screen_name）推荐的世界，省略=全部'
        },
        refresh: {
          type: 'boolean',
          description: '是否先抓取博主最新推文再查询，默认 false',
          default: false
        }
      }
    },
    handler: async (args) => api.consume('x.worldDigest', args)
  });

  api.registerTool({
    name: 'x_scan_creators',
    description: '[查询·X推荐] 立即抓取所有已配置博主的最新推文，提取推荐的世界并查询收藏/浏览数据入库。',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async (args) => api.consume('x.scanCreators', args)
  });

  api.registerTool({
    name: 'x_creators',
    description: '[查询·X推荐] 列出当前配置的 X 博主清单。',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async (args) => api.consume('x.creators', args)
  });

  api.registerTool({
    name: 'x_add_creator',
    description: '[配置·X推荐] 添加要追踪的 X 博主（VRChat 世界推荐博主）。screen_name 是 X 用户名（不带 @）。',
    inputSchema: {
      type: 'object',
      properties: {
        screen_name: {
          type: 'string',
          description: 'X 用户名，如 fox_yata9（必填）'
        },
        name: {
          type: 'string',
          description: '博主显示名（可选）'
        }
      },
      required: [
        'screen_name'
      ]
    },
    handler: async (args) => api.consume('x.addCreator', args)
  });

  api.registerTool({
    name: 'x_remove_creator',
    description: '[配置·X推荐] 移除追踪的 X 博主。',
    inputSchema: {
      type: 'object',
      properties: {
        screen_name: {
          type: 'string',
          description: 'X 用户名（不带 @）'
        }
      },
      required: [
        'screen_name'
      ]
    },
    handler: async (args) => api.consume('x.removeCreator', args)
  });

  api.registerTool({
    name: 'x_worlds',
    description: '[查询·X推荐] 查看已收录的推荐世界列表（调试用）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '返回条数上限，默认 50',
          default: 50
        }
      }
    },
    handler: async (args) => api.consume('x.worlds', args)
  });
}
