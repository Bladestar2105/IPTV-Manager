
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = path.join(__dirname, 'temp_db_proxy');

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
  const { encrypt } = await import('../../src/utils/crypto.js');

  console.log('Setup: Initializing DB schema...');
  // Initialize DB schema
  initDb(true);

  // Insert test users
  console.log('Setup: Creating test users...');
  // Encrypt the password so authService can decrypt it
  const encryptedPassword = encrypt('pass2');
  db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('attacker', encryptedPassword);

  const { proxySegment } = await import('../../src/controllers/streamController.js');

  const req = {
    ip: '127.0.0.1',
    params: {
        username: 'attacker',
        password: 'pass2'
    },
    query: {
        url: 'http://google.com'
    },
    headers: {
        'user-agent': 'Mozilla/5.0'
    },
    protocol: 'http',
    get: (h) => (h === 'host' ? 'localhost' : ''),
    on: () => {}
  };

  let responseStatus = 0;
  let responseBody = {};
  let headers = {};

  const res = {
    status: (code) => {
      responseStatus = code;
      return res;
    },
    sendStatus: (code) => {
      responseStatus = code;
      return res;
    },
    json: (body) => {
      responseBody = body;
      return res;
    },
    setHeader: (k, v) => {
        headers[k] = v;
    },
    send: (body) => {
        responseBody = body;
    },
    headersSent: false
  };

  console.log('Test: Attacker attempting to use Open Proxy via url parameter...');
  try {
      await proxySegment(req, res);
  } catch(e) {
      console.log('Proxy segment threw error (expected if fetch fails):', e.message);
  }

  console.log(`Response Status: ${responseStatus}`);

  // Logic:
  // If status is 400 -> It means 'url' param was IGNORED (and 'data' was missing). Secure.
  // If status is NOT 400 (e.g. 200, 502, 403, 500) -> It means 'url' param was PROCESSED. Vulnerable.

  if (responseStatus === 400) {
      console.log('✅ SECURE: Request rejected (400 Bad Request) because "url" param is ignored.');
      process.exit(0);
  } else {
      console.error(`❌ VULNERABILITY DETECTED: Request processed with status ${responseStatus}. "url" param is active.`);
      process.exit(1);
  }
}

run().catch(err => {
  console.error('Test Error:', err);
  process.exit(1);
});
