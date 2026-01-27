import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT_DIR, 'db.sqlite');
const MOCK_SERVER_PORT = 4000;
const SERVER_PORT = 3000;
const MOCK_SERVER_SCRIPT = path.join(__dirname, 'mock_server.js');
const SERVER_SCRIPT = path.join(ROOT_DIR, 'server.js');

let mockServerProcess;
let serverProcess;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function killPort(port) {
  try {
    execSync(`kill $(lsof -t -i :${port}) 2>/dev/null || true`);
  } catch (e) {
    // ignore
  }
}

async function startMockServer() {
  console.log('Starting mock server...');
  mockServerProcess = spawn('node', [MOCK_SERVER_SCRIPT], { stdio: 'inherit' });
  await sleep(1000);
}

async function startServer() {
  console.log('Starting main server...');
  killPort(SERVER_PORT);

  serverProcess = spawn('node', [SERVER_SCRIPT], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: SERVER_PORT },
  });

  serverProcess.stderr.on('data', (data) => console.error(`SERVER ERR: ${data}`));

  return new Promise((resolve) => {
    const onData = (data) => {
      const str = data.toString();
      // console.log(`SERVER: ${str}`);
      if (str.includes('IPTV-Manager')) {
        serverProcess.stdout.removeListener('data', onData);
        resolve();
      }
    };
    serverProcess.stdout.on('data', onData);
  });
}

function stopServers() {
  if (mockServerProcess) {
    mockServerProcess.kill();
    killPort(MOCK_SERVER_PORT);
  }
  if (serverProcess) {
    serverProcess.kill();
    killPort(SERVER_PORT);
  }
}

async function prepareDB() {
  console.log('Preparing DB...');

  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
  }

  // Start server briefly to initialize Schema
  await startServer();
  serverProcess.kill();
  await sleep(1000);

  const db = new Database(DB_PATH);

  const hashedPassword = await bcrypt.hash('password123', 10);
  db.prepare('INSERT INTO admin_users (username, password, is_active) VALUES (?, ?, 1)')
    .run('benchadmin', hashedPassword);

  const insertProvider = db.prepare('INSERT INTO providers (name, url, username, password, epg_url) VALUES (?, ?, ?, ?, ?)');

  db.transaction(() => {
    for (let i = 1; i <= 10; i++) {
        insertProvider.run(
            `Provider ${i}`,
            'http://example.com',
            'user',
            'pass',
            `http://localhost:${MOCK_SERVER_PORT}/epg`
        );
    }
  })();

  db.close();
  console.log('DB Prepared with 10 providers.');
}

async function runBenchmark() {
    try {
        killPort(MOCK_SERVER_PORT);
        killPort(SERVER_PORT);

        await startMockServer();
        await prepareDB();
        await startServer();

        console.log('Logging in...');
        const loginRes = await fetch(`http://localhost:${SERVER_PORT}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'benchadmin', password: 'password123' })
        });

        const loginData = await loginRes.json();
        if (!loginData.token) {
            throw new Error('Login failed: ' + JSON.stringify(loginData));
        }

        const token = loginData.token;

        console.log('Running update-all...');
        const start = Date.now();
        const res = await fetch(`http://localhost:${SERVER_PORT}/api/epg-sources/update-all`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        const end = Date.now();

        if (!res.ok) {
             const txt = await res.text();
             throw new Error(`Update failed: ${res.status} ${txt}`);
        }

        const result = await res.json();
        console.log('Update result status:', result.success);

        const duration = end - start;
        console.log(`\n\n---------------------------------------------------`);
        console.log(`BENCHMARK RESULT: ${duration} ms`);
        console.log(`---------------------------------------------------\n`);

    } catch (e) {
        console.error('Benchmark failed:', e);
    } finally {
        stopServers();
    }
}

runBenchmark();
