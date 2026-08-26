-- events 插件私有表（自动加 plg_events_ 前缀；表别名避免含 "events" 以免前缀正则误判）
CREATE TABLE IF NOT EXISTS plg_events_store (
  source      TEXT NOT NULL,          -- vrcsearch | rlvrc | vrceve | vrckr
  name        TEXT NOT NULL,
  start_iso   TEXT NOT NULL,
  end_iso     TEXT DEFAULT '',
  category    TEXT DEFAULT '',
  lang        TEXT DEFAULT '',
  languages   TEXT DEFAULT '',        -- JSON 数组
  desc_raw    TEXT DEFAULT '',
  desc_zh     TEXT DEFAULT '',
  group_id    TEXT DEFAULT '',
  group_name  TEXT DEFAULT '',
  member_count INTEGER DEFAULT 0,
  icon_url    TEXT DEFAULT '',
  shortcode   TEXT DEFAULT '',
  join_info   TEXT DEFAULT '',
  page_url    TEXT DEFAULT '',
  page_label  TEXT DEFAULT '',
  src         TEXT DEFAULT '',
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (source, name, start_iso)
);
CREATE INDEX IF NOT EXISTS idx_events_store_fetched ON plg_events_store (fetched_at);
CREATE INDEX IF NOT EXISTS idx_events_store_group ON plg_events_store (group_id);

-- 插件配置（键值对，如 google_calendar_api_key = 使用者的 Google API Key）
CREATE TABLE IF NOT EXISTS plg_events_config (
  cfg_key  TEXT PRIMARY KEY,
  cfg_val  TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);