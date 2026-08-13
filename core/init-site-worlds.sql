-- 世界推荐网站分析（world_analytics 工具维护）
-- 数据源：PlanetVRC (planetvrchat.net) WordPress REST API + vrclist.com + VRChat API

CREATE TABLE IF NOT EXISTS site_world_recommendations (
  world_id TEXT PRIMARY KEY,
  world_name TEXT NOT NULL,
  author_name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  favorites INTEGER DEFAULT 0,
  visits INTEGER DEFAULT 0,
  popularity INTEGER DEFAULT 0,
  capacity INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  source TEXT DEFAULT 'planetvrchat',       -- 来源站：planetvrchat / vrclist
  source_id TEXT DEFAULT '',                -- 来源站内的 ID（如帖子 ID）
  source_url TEXT DEFAULT '',               -- 来源站链接
  source_date TEXT DEFAULT '',              -- 来源站发布日期（ISO）
  category TEXT DEFAULT '',                 -- 类型（quest/feature_tag 等分类名）
  first_seen_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT DEFAULT (datetime('now')),
  UNIQUE(world_id, source)
);

-- 抓取快照表（记录每次扫描，用于日/周/月趋势分析）
CREATE TABLE IF NOT EXISTS site_world_scan_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_date TEXT NOT NULL,                  -- 抓取日期（YYYY-MM-DD）
  source TEXT DEFAULT 'planetvrchat',
  world_id TEXT NOT NULL,
  world_name TEXT,
  favorites INTEGER DEFAULT 0,
  visits INTEGER DEFAULT 0,
  popularity INTEGER DEFAULT 0,
  UNIQUE(scan_date, source, world_id)
);
