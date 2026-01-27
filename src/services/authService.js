import db from '../config/database.js';
import bcrypt from 'bcrypt';
import path from 'path';
import fs from 'fs';
import { ROOT_DIR } from '../config/paths.js';
import dotenv from 'dotenv';

dotenv.config();

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 10;

export async function createDefaultAdmin() {
  try {
    const adminCount = db.prepare('SELECT COUNT(*) as count FROM admin_users').get();

    if (adminCount.count === 0) {
      // Generate random password
      const crypto = await import('crypto');
      const randomPassword = crypto.randomBytes(8).toString('hex');
      const username = 'admin';

      // Hash password
      const hashedPassword = await bcrypt.hash(randomPassword, BCRYPT_ROUNDS);

      // Create admin user in admin_users table (NOT in users table)
      db.prepare('INSERT INTO admin_users (username, password, is_active) VALUES (?, ?, 1)')
        .run(username, hashedPassword);

      console.log('\n' + '='.repeat(60));
      console.log('🔐 DEFAULT ADMIN USER CREATED (WebGUI Only)');
      console.log('='.repeat(60));
      console.log(`Username: ${username}`);
      console.log(`Password: ${randomPassword}`);
      console.log('='.repeat(60));
      console.log('⚠️  IMPORTANT: Please change this password after first login!');
      console.log('ℹ️  NOTE: Admin user is for WebGUI only, not for IPTV streams!');
      console.log('='.repeat(60) + '\n');

      // Save credentials to file for reference
      const credentialsFile = path.join(ROOT_DIR, 'ADMIN_CREDENTIALS.txt');
      const credentialsContent = `IPTV-Manager Default Admin Credentials\nGenerated: ${new Date().toISOString()}\n\nUsername: ${username}\nPassword: ${randomPassword}\n\n⚠️ IMPORTANT: \n- Change this password immediately after first login\n- Delete this file after noting the credentials\n- Keep these credentials secure\n- This admin user is for WebGUI management only\n- Create separate users for IPTV stream access\n`;

      fs.writeFileSync(credentialsFile, credentialsContent);
      console.log(`📄 Credentials also saved to: ${credentialsFile}\n`);
    }
  } catch (error) {
    console.error('❌ Error creating default admin:', error);
  }
}

export async function authUser(username, password) {
  try {
    const u = (username || '').trim();
    const p = (password || '').trim();
    if (!u || !p) return null;

    const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(u);
    if (!user) return null;

    // Compare password with hashed password
    const isValid = await bcrypt.compare(p, user.password);
    return isValid ? user : null;
  } catch (e) {
    console.error('authUser error:', e);
    return null;
  }
}
