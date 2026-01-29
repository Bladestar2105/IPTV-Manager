CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  epg_url TEXT,
  user_id INTEGER,
  epg_update_interval INTEGER DEFAULT 86400,
  epg_enabled INTEGER DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS provider_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  remote_stream_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  original_category_id INTEGER DEFAULT 0,
  logo TEXT DEFAULT '',
  stream_type TEXT DEFAULT 'live',
  epg_channel_id TEXT DEFAULT '',
  original_sort_order INTEGER DEFAULT 0,
  UNIQUE(provider_id, remote_stream_id)
);

CREATE TABLE IF NOT EXISTS user_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_adult INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_category_id INTEGER NOT NULL,
  provider_channel_id INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (user_category_id) REFERENCES user_categories(id),
  FOREIGN KEY (provider_channel_id) REFERENCES provider_channels(id)
);

CREATE TABLE IF NOT EXISTS category_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  provider_category_id INTEGER NOT NULL,
  provider_category_name TEXT NOT NULL,
  user_category_id INTEGER,
  auto_created INTEGER DEFAULT 0,
  UNIQUE(provider_id, user_id, provider_category_id),
  FOREIGN KEY (provider_id) REFERENCES providers(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (user_category_id) REFERENCES user_categories(id)
);
