import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BCRYPT_ROUNDS = 10;

async function migratePasswords() {
  console.log('🔄 Starting password migration...');
  
  const db = new Database(path.join(__dirname, 'db.sqlite'));
  
  try {
    // Get all users
    const users = db.prepare('SELECT id, username, password FROM users').all();
    
    console.log(`Found ${users.length} users to migrate`);
    
    for (const user of users) {
      // Check if password is already hashed (bcrypt hashes start with $2b$)
      if (user.password.startsWith('$2b$')) {
        console.log(`✅ User "${user.username}" already has hashed password, skipping`);
        continue;
      }
      
      // Hash the plain text password
      const hashedPassword = await bcrypt.hash(user.password, BCRYPT_ROUNDS);
      
      // Update the user
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, user.id);
      
      console.log(`✅ Migrated password for user "${user.username}"`);
    }
    
    // Get all providers
    const providers = db.prepare('SELECT id, name, password FROM providers').all();
    
    console.log(`\nFound ${providers.length} providers to migrate`);
    
    for (const provider of providers) {
      // Check if password is already hashed
      if (provider.password.startsWith('$2b$')) {
        console.log(`✅ Provider "${provider.name}" already has hashed password, skipping`);
        continue;
      }
      
      // Hash the plain text password
      const hashedPassword = await bcrypt.hash(provider.password, BCRYPT_ROUNDS);
      
      // Update the provider
      db.prepare('UPDATE providers SET password = ? WHERE id = ?').run(hashedPassword, provider.id);
      
      console.log(`✅ Migrated password for provider "${provider.name}"`);
    }
    
    console.log('\n✅ Password migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

// Run migration
migratePasswords();