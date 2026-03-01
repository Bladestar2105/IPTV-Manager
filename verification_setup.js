import db from './src/database/db.js';
import bcrypt from 'bcrypt';

const hash = bcrypt.hashSync('adminpass', 10);
// Try to update admin user, if not exists insert
const res = db.prepare('UPDATE users SET password = ? WHERE username = ?').run(hash, 'admin');

const adminUser = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (adminUser) {
    db.prepare('DELETE FROM user_backups WHERE user_id = ?').run(adminUser.id);
    const insertStmt = db.prepare(`
        INSERT INTO user_backups (user_id, name, timestamp, category_count, channel_count, data)
        VALUES (?, ?, ?, 0, 0, '{}')
    `);
    for(let i=0; i<5; i++) {
        insertStmt.run(adminUser.id, `Backup ${i+1}`, Date.now() - (i*1000));
    }
    console.log('Admin user setup for testing');
} else {
    console.log('Admin user not found. Was the server completely booted and initialized?');
}
