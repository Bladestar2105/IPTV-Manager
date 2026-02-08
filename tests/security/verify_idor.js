
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = path.join(__dirname, 'temp_db');

// Set env var before importing any app code
process.env.DATA_DIR = tempDir;

// Cleanup previous runs
if (fs.existsSync(tempDir)) {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
fs.mkdirSync(tempDir, { recursive: true });

async function run() {
  console.log('Setup: Importing DB...');
  const { default: db, initDb } = await import('../../src/database/db.js');

  console.log('Setup: Initializing DB schema...');
  // Initialize DB schema
  initDb(true);

  // Insert test users
  console.log('Setup: Creating test users...');
  db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('victim', 'pass1');
  const victim = db.prepare('SELECT * FROM users WHERE username = ?').get('victim');

  db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('attacker', 'pass2');
  const attacker = db.prepare('SELECT * FROM users WHERE username = ?').get('attacker');

  console.log(`Victim ID: ${victim.id}, Attacker ID: ${attacker.id}`);

  const { createPlayerToken } = await import('../../src/controllers/authController.js');

  // Mock Request/Response
  const req = {
    user: { id: attacker.id, is_admin: false, username: attacker.username },
    body: { user_id: victim.id }
  };

  let responseStatus = 0;
  let responseBody = {};

  const res = {
    status: (code) => {
      responseStatus = code;
      return res;
    },
    json: (body) => {
      responseBody = body;
      return res;
    }
  };

  console.log('Test: Attacker attempting to generate token for Victim...');
  await createPlayerToken(req, res);

  console.log(`Response Status: ${responseStatus}`);
  console.log(`Response Body:`, responseBody);

  // Verification
  // In Express, if status() is not called, it defaults to 200.
  // My mock starts with 0, so 0 or 200 means success.
  if ((responseStatus === 200 || responseStatus === 0) && responseBody.token) {
    console.error('❌ VULNERABILITY DETECTED: Attacker successfully generated token for Victim!');
    process.exit(1); // Fail
  } else if (responseStatus === 403) {
    console.log('✅ SECURE: Access Denied (403)');
    process.exit(0); // Pass
  } else {
    console.log(`⚠️ Unexpected response: ${responseStatus}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Test Error:', err);
  process.exit(1);
});
