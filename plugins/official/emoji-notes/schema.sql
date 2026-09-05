-- emoji-notes 插件私有表（裸别名 notes，loader 重写为 "plg_emoji-notes_notes"）
-- emoji_id 两类：内置 default_xxx / 自定义 file_xxx
CREATE TABLE IF NOT EXISTS notes (
  emoji_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'custom',
  note TEXT DEFAULT '',
  aliases TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  category TEXT DEFAULT '',
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
