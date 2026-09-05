// store.js — emoji-notes 语料装载与 set/get/softDelete（SQL 一律参数化，表别名始终写 notes）
import { normalizeHanzi, toPinyinStr } from './resolve.js';

const corpusCache = new Map(); // db handle -> 语料数组（set/softDelete 时清除）

/** 清空语料缓存（dispose 用）；传 db 只清该 db 的缓存 */
export function clearCorpusCache(db) {
  if (db === undefined) corpusCache.clear();
  else corpusCache.delete(db);
}

function parseJsonArray(raw) {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toCleanArray(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function rowToRecord(row) {
  return {
    emojiId: row.emoji_id,
    kind: row.kind,
    note: row.note ?? '',
    aliases: parseJsonArray(row.aliases),
    tags: parseJsonArray(row.tags),
    category: row.category ?? '',
    deleted: row.deleted ? 1 : 0,
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  };
}

/** 读 deleted=0 全量语料，每条预计算双通道表示（汉字归一化 + 拼音归一化） */
export function loadCorpus(db) {
  const cached = corpusCache.get(db);
  if (cached) return cached;
  const rows = db.all('SELECT * FROM notes WHERE deleted = 0');
  const corpus = rows.map((r) => {
    const note = typeof r.note === 'string' ? r.note : '';
    const aliases = parseJsonArray(r.aliases);
    const tags = parseJsonArray(r.tags);
    // 拼音必须对归一化后的字符串计算（原始文本含空格会被 pinyin-pro 并入 nonZh token）
    const noteHans = normalizeHanzi(note);
    const aliasesHans = aliases.map(normalizeHanzi);
    const tagsHans = tags.map(normalizeHanzi);
    return {
      emojiId: r.emoji_id,
      kind: r.kind,
      note,
      noteHans,
      notePinyin: toPinyinStr(noteHans),
      aliases,
      aliasesHans,
      aliasesPinyin: aliasesHans.map(toPinyinStr),
      tags,
      tagsHans,
      tagsPinyin: tagsHans.map(toPinyinStr),
    };
  });
  corpusCache.set(db, corpus);
  return corpus;
}

/**
 * upsert 一条备注（整表替换语义）。
 * note 与 aliases 都为空 → 软删除；否则 INSERT ... ON CONFLICT DO UPDATE。
 * 校验：note ≤ 2000 字符、aliases ≤ 50 个、单个别名 ≤ 100 字符。
 * 返回落库后完整记录（软删除到不存在的行返回 null）。
 */
export function upsertNote(db, args = {}) {
  const emojiId = String(args.emojiId ?? '').trim();
  if (!emojiId) throw new Error('emojiId 必填');

  const note = typeof args.note === 'string' ? args.note.trim() : '';
  const aliases = toCleanArray(args.aliases);
  const tags = toCleanArray(args.tags);
  const category = typeof args.category === 'string' ? args.category.trim() : '';
  const kind =
    args.kind === 'builtin' || args.kind === 'custom'
      ? args.kind
      : emojiId.startsWith('default_')
        ? 'builtin'
        : 'custom';

  if (note.length > 2000) throw new Error('note 超长（上限 2000 字符）');
  if (aliases.length > 50) throw new Error('aliases 过多（上限 50 个）');
  for (const a of aliases) {
    if (a.length > 100) throw new Error('单个别名超长（上限 100 字符）');
  }

  if (!note && aliases.length === 0) {
    db.run(`UPDATE notes SET deleted = 1, updated_at = datetime('now') WHERE emoji_id = $id`, { id: emojiId });
    corpusCache.delete(db);
    const row = db.get('SELECT * FROM notes WHERE emoji_id = $id', { id: emojiId });
    return row ? rowToRecord(row) : null;
  }

  db.run(
    `INSERT INTO notes (emoji_id, kind, note, aliases, tags, category)
     VALUES ($id, $kind, $note, $aliases, $tags, $category)
     ON CONFLICT(emoji_id) DO UPDATE SET
       kind = excluded.kind,
       note = excluded.note,
       aliases = excluded.aliases,
       tags = excluded.tags,
       category = excluded.category,
       deleted = 0,
       updated_at = datetime('now')`,
    {
      id: emojiId,
      kind,
      note,
      aliases: JSON.stringify(aliases),
      tags: JSON.stringify(tags),
      category,
    }
  );
  corpusCache.delete(db);
  const row = db.get('SELECT * FROM notes WHERE emoji_id = $id', { id: emojiId });
  return row ? rowToRecord(row) : null;
}

/** 列出备注：默认只查 deleted=0，可按 emojiId/kind 过滤，limit 默认 100 */
export function getNotes(db, { emojiId, kind, includeDeleted, limit } = {}) {
  const conds = [];
  const params = {};
  if (typeof emojiId === 'string' && emojiId.trim()) {
    conds.push('emoji_id = $emojiId');
    params.emojiId = emojiId.trim();
  }
  if (kind === 'builtin' || kind === 'custom') {
    conds.push('kind = $kind');
    params.kind = kind;
  }
  if (!includeDeleted) conds.push('deleted = 0');
  let sql = 'SELECT * FROM notes';
  if (conds.length > 0) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY updated_at DESC LIMIT $limit';
  params.limit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const rows = db.all(sql, params);
  return rows.map(rowToRecord);
}

/** 软删除：置 deleted=1 + updated_at */
export function softDelete(db, emojiId) {
  const id = String(emojiId ?? '').trim();
  if (!id) throw new Error('emojiId 必填');
  db.run(`UPDATE notes SET deleted = 1, updated_at = datetime('now') WHERE emoji_id = $id`, { id });
  corpusCache.delete(db);
}
