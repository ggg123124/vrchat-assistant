// index.js — emoji-notes 官方插件入口：注册 set_emoji_note / get_emoji_notes / resolve_emoji
import { upsertNote, getNotes, loadCorpus, clearCorpusCache } from './store.js';
import { resolve as resolveQuery } from './resolve.js';
import builtinEmojis from './builtin-emojis.js';

export default function register(api) {
  const db = api.db.table('notes');

  // 索引在此建（幂等）：schema.sql 里的索引不会被 loader 重写表名，只能走 api.db 的 rewrite
  db.exec('CREATE INDEX IF NOT EXISTS idx_notes_kind ON notes(kind)');

  api.registerTool({
    name: 'set_emoji_note',
    description:
      '[manage] 给 emojiId（内置 default_xxx 或自定义 fileId）设备注/别名，存本地。note 与 aliases 都为空时清除该条。',
    inputSchema: {
      type: 'object',
      properties: {
        emojiId: { type: 'string', description: "emojiId：内置 'default_xxx' 或上传返回的 fileId（file_xxx）" },
        note: { type: 'string', description: '主备注/描述（图的内容/用途）' },
        aliases: {
          type: 'array',
          items: { type: 'string' },
          description: '别名列表（多个口语称呼/记法，如 ["狐狸检查PR","审核PR","狐狸"]）',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '可选关键词/主题标签' },
        category: { type: 'string', description: '可选用户自定义分类' },
      },
      required: ['emojiId'],
    },
    handler: async (args) => {
      const rec = upsertNote(db, args ?? {});
      api.log(
        `set_emoji_note ${args?.emojiId} -> ${rec ? `kind=${rec.kind} deleted=${rec.deleted}` : '无该行（软删除前也不存在）'}`
      );
      return rec;
    },
  });

  api.registerTool({
    name: 'get_emoji_notes',
    description: '[query] 列出 emoji 备注（可按 emojiId / kind 过滤，默认只返回有效项）。',
    inputSchema: {
      type: 'object',
      properties: {
        emojiId: { type: 'string', description: '精确查单条' },
        kind: { type: 'string', enum: ['builtin', 'custom'], description: '按来源过滤' },
        includeDeleted: { type: 'boolean', description: '是否包含软删除项（默认 false）' },
        limit: { type: 'number', description: '返回上限（默认 100）' },
      },
    },
    handler: async (args) => getNotes(db, args ?? {}),
  });

  api.registerTool({
    name: 'resolve_emoji',
    description:
      '[query] 把口语化/可能带 STT 噪声的中文表情描述解析成 emojiId。支持别名/拼音同音/子串/分词重叠/编辑距离匹配，返回候选+置信度；歧义时返回候选不瞎猜。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '用户口述的表情描述（STT 转文字后，如「狐狸检查PR」「大笑」「弧狸检查PR」）',
        },
        limit: { type: 'number', description: '返回候选数上限（默认 5）' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const query = args && typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) throw new Error('query 必填（用户口述的表情描述）');
      const corpus = loadCorpus(db);
      const result = resolveQuery(query, corpus, builtinEmojis, { limit: args?.limit });
      api.log(
        `resolve_emoji "${query.slice(0, 50)}" matched=${result.matched} candidates=${result.candidates.length} top=${result.candidates[0]?.emojiId ?? '-'}`
      );
      return result;
    },
  });

  return () => {
    clearCorpusCache(db);
  };
}
