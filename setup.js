import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';

const db = new Database('db.sqlite');
const hash = bcrypt.hashSync('admin123', 10);
db.prepare("UPDATE admin_users SET password = ?, force_password_change = 0 WHERE username = 'admin'").run(hash);

// Create dummy data to test rename
db.prepare("INSERT OR REPLACE INTO users (id, username, password) VALUES (999, 'testuser', 'testpass')").run();
db.prepare("INSERT OR REPLACE INTO providers (id, user_id, name, url, username, password) VALUES (999, 999, 'Test Provider', 'http://test', 'u', 'p')").run();
db.prepare("INSERT OR REPLACE INTO user_categories (id, user_id, name, type) VALUES (999, 999, 'Test Category', 'live')").run();
db.prepare("INSERT OR REPLACE INTO provider_channels (id, provider_id, remote_stream_id, name, stream_type) VALUES (999, 999, 999, 'Original Channel Name', 'live')").run();
db.prepare("INSERT OR REPLACE INTO user_channels (id, user_category_id, provider_channel_id) VALUES (999, 999, 999)").run();
db.close();
