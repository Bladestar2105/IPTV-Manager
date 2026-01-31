const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../db.sqlite');
const PORT = 3000;
const TARGET_PORT = 8888;
const TOKEN = 'test-token-ssrf';

async function main() {
  console.log('🚀 Starting SSRF Reproduction...');

  // 1. Setup DB
  console.log('💾 Setting up Database...');
  const db = new Database(DB_PATH);

  // Ensure tables exist (running server creates them, but we might run before server or server takes time)
  // Actually, let's let server run first for a second to init DB if needed,
  // OR we just wait for server to be ready.
  // But to insert token, we need tables.

  // Let's assume DB exists or we can create minimal schema?
  // No, safer to rely on server to init.
  // But we need token to request.

  // Solution: Start server, wait for "Database OK", then insert token.
}

(async () => {
  let serverProcess;
  let targetServer;

  try {
    // 1. Start Target Server (Internal Service)
    targetServer = http.createServer((req, res) => {
      console.log(`🎯 Target Server hit: ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('SECRET_DATA_FROM_INTERNAL_SERVER');
    });
    targetServer.listen(TARGET_PORT);
    console.log(`🎯 Target server listening on ${TARGET_PORT}`);

    // 2. Start Main Server
    console.log('🚀 Starting Main Server...');
    serverProcess = spawn('node', ['src/server.js'], {
      cwd: path.join(__dirname, '../'),
      env: { ...process.env, PORT: PORT.toString() }
    });

    serverProcess.stdout.on('data', (data) => {
        // console.log(`[Server]: ${data}`);
        if (data.toString().includes('IPTV-Manager: http://localhost')) {
             console.log('✅ Main Server is ready');
             runTest();
        }
    });

    serverProcess.stderr.on('data', (data) => console.error(`[Server Error]: ${data}`));

    async function runTest() {
        // 3. Insert Token
        const db = new Database(DB_PATH);
        try {
            // Create user if not exists
            const user = db.prepare('SELECT * FROM users WHERE username = ?').get('testuser');
            let userId = user ? user.id : 0;
            if (!user) {
                const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('testuser', 'testpass');
                userId = info.lastInsertRowid;
            }

            // Insert token
            const expires = Math.floor(Date.now() / 1000) + 3600;
            db.prepare('INSERT OR REPLACE INTO temporary_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
              .run(TOKEN, userId, expires);

            console.log('🔑 Injected auth token');
        } catch(e) {
            console.error('DB Error:', e);
            process.exit(1);
        }

        // 4. Perform Attack
        const targetUrl = `http://localhost:${TARGET_PORT}/secret`;
        const encodedUrl = encodeURIComponent(targetUrl);
        // Using dummy username/password because we have a token
        const attackUrl = `http://localhost:${PORT}/live/segment/user/pass/seg.ts?url=${encodedUrl}&token=${TOKEN}`;

        console.log(`⚔️  Sending SSRF Request to: ${attackUrl}`);

        try {
            const fetch = (await import('node-fetch')).default;
            const res = await fetch(attackUrl);

            console.log(`📡 Response Status: ${res.status}`);

            if (res.status === 200) {
                const text = await res.text();
                if (text === 'SECRET_DATA_FROM_INTERNAL_SERVER') {
                    console.log('🚨 VULNERABILITY CONFIRMED: Successfully accessed internal server!');
                } else {
                     console.log('⚠️  Response 200 but content mismatch:', text);
                }
            } else if (res.status === 400 || res.status === 403) {
                console.log('✅ SECURE: Request blocked.');
            } else {
                console.log('❓ Unexpected status.');
            }

        } catch (e) {
            console.error('Request failed:', e);
        } finally {
            cleanup();
        }
    }

  } catch (e) {
    console.error(e);
    cleanup();
  }

  function cleanup() {
    if (serverProcess) serverProcess.kill();
    if (targetServer) targetServer.close();
    process.exit(0);
  }

})();
