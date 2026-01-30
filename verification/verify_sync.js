import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MOCK_PORT = 3001;
const APP_PORT = 3002;
const DATA_DIR = path.join(__dirname, '../temp_test_data');
const INITIAL_ADMIN_PASSWORD = 'admin123';

// State for Mock Provider
let providerState = {
    categories: [
        { category_id: "1", category_name: "Category A", parent_id: 0 }
    ],
    channels: [
        { num: 1, name: "Channel 1", stream_type: "live", stream_id: 1, category_id: "1" }
    ]
};

// Create Mock Provider Server
const mockServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${MOCK_PORT}`);
    const action = url.searchParams.get('action');

    res.setHeader('Content-Type', 'application/json');

    if (action === 'get_live_categories') {
        res.end(JSON.stringify(providerState.categories));
        return;
    }

    if (action === 'get_live_streams') {
        res.end(JSON.stringify(providerState.channels));
        return;
    }

    res.end(JSON.stringify([]));
});

// Helper: HTTP Request
async function apiCall(method, endpoint, body, token = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`http://localhost:${APP_PORT}${endpoint}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    try {
        return { status: response.status, data: JSON.parse(text) };
    } catch {
        return { status: response.status, data: text };
    }
}

async function runTest() {
    console.log("🚀 Starting Verification Test...");

    // 1. Setup Data Dir
    if (fs.existsSync(DATA_DIR)) {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(DATA_DIR);

    // 2. Start Mock Server
    await new Promise(resolve => mockServer.listen(MOCK_PORT, resolve));
    console.log(`✅ Mock Provider running on port ${MOCK_PORT}`);

    // 3. Start App Server
    console.log("⏳ Starting App Server...");
    const appProcess = spawn('node', ['src/server.js'], {
        env: {
            ...process.env,
            PORT: APP_PORT,
            DATA_DIR: DATA_DIR,
            INITIAL_ADMIN_PASSWORD: INITIAL_ADMIN_PASSWORD,
            JWT_SECRET: 'testsecret'
        },
        stdio: 'pipe' // Capture output
    });

    // Wait for App Server to be ready
    await new Promise((resolve, reject) => {
        appProcess.stdout.on('data', (data) => {
            const msg = data.toString();
            // console.log(`[APP]: ${msg.trim()}`);
            if (msg.includes(`http://localhost:${APP_PORT}`)) {
                resolve();
            }
        });

        appProcess.stderr.on('data', (data) => console.error(`[APP ERR]: ${data.toString()}`));

        appProcess.on('exit', (code) => {
             if (code !== null) reject(new Error(`App exited with code ${code}`));
        });

        // Timeout
        setTimeout(() => reject(new Error("Timeout waiting for app start")), 10000);
    });
    console.log(`✅ App Server running on port ${APP_PORT}`);

    try {
        // 4. Login
        console.log("🔑 Logging in...");
        const loginRes = await apiCall('POST', '/api/login', { username: 'admin', password: INITIAL_ADMIN_PASSWORD });
        if (loginRes.status !== 200) throw new Error("Login failed");
        const token = loginRes.data.token;

        // 5. Create User
        console.log("👤 Creating IPTV User...");
        const userRes = await apiCall('POST', '/api/users', { username: 'testuser', password: 'password123' }, token);
        if (userRes.status !== 200) throw new Error("Create user failed");
        const userId = userRes.data.id;

        // 6. Create Provider
        console.log("📺 Creating Provider...");
        const provRes = await apiCall('POST', '/api/providers', {
            name: 'Test Provider',
            url: `http://localhost:${MOCK_PORT}`,
            username: 'u',
            password: 'p'
        }, token);
        if (provRes.status !== 200) throw new Error("Create provider failed");
        const providerId = provRes.data.id;

        // 7. Create Sync Config
        console.log("⚙️  Configuring Sync...");
        await apiCall('POST', '/api/sync-configs', {
            provider_id: providerId,
            user_id: userId,
            enabled: true,
            auto_add_categories: true,
            auto_add_channels: true
        }, token);

        // 8. First Sync
        console.log("🔄 Running First Sync...");
        const sync1 = await apiCall('POST', `/api/providers/${providerId}/sync`, { user_id: userId }, token);
        if (sync1.status !== 200) throw new Error("Sync 1 failed: " + JSON.stringify(sync1.data));

        console.log("   First Sync Result:", sync1.data);
        // Expect: Categories Added = 1 (to system), but NOT auto-added to user because it's first sync.
        // Wait, 'categories_added' in sync return value counts user categories created.
        // Logic: if (!mapping && isFirstSync) -> no user category created.

        // Verify User Categories
        const cats1 = await apiCall('GET', `/api/users/${userId}/categories`, null, token);
        if (cats1.data.length !== 0) {
             throw new Error("Expected 0 user categories after first sync, got " + cats1.data.length);
        }
        console.log("   ✅ First sync behavior correct: No user categories created automatically.");

        // 9. Manual Import (Simulate User)
        console.log("📥 Manually Importing Category A...");
        // Need mapping to get provider_category_id (it is '1')
        // Import it
        await apiCall('POST', `/api/providers/${providerId}/import-category`, {
            user_id: userId,
            category_id: "1",
            category_name: "Category A",
            import_channels: true
        }, token);

        const catsAfterImport = await apiCall('GET', `/api/users/${userId}/categories`, null, token);
        if (catsAfterImport.data.length !== 1) throw new Error("Import failed");
        console.log("   ✅ Category A imported.");

        // 10. Update Mock Data
        console.log("📝 Updating Mock Data (New Category B, New Channel in A)...");
        providerState.categories.push({ category_id: "2", category_name: "Category B", parent_id: 0 });
        providerState.channels.push({ num: 2, name: "Channel 2", stream_type: "live", stream_id: 2, category_id: "2" }); // In New Cat
        providerState.channels.push({ num: 3, name: "Channel 3", stream_type: "live", stream_id: 3, category_id: "1" }); // In Existing Cat

        // 11. Second Sync
        console.log("🔄 Running Second Sync...");
        const sync2 = await apiCall('POST', `/api/providers/${providerId}/sync`, { user_id: userId }, token);
        if (sync2.status !== 200) throw new Error("Sync 2 failed");
        console.log("   Second Sync Result:", sync2.data);

        // 12. Verification
        console.log("🔍 Verifying Results...");

        // Check Categories
        const cats2 = await apiCall('GET', `/api/users/${userId}/categories`, null, token);
        const catB = cats2.data.find(c => c.name === "Category B");

        if (!catB) {
             console.error("User Categories:", cats2.data);
             throw new Error("❌ FAILURE: Category B was NOT automatically created!");
        }
        console.log("   ✅ Category B automatically created.");

        // Check Channels in Category A (Channel 3 should be added)
        const catA = cats2.data.find(c => c.name === "Category A");
        const channelsA = await apiCall('GET', `/api/user-categories/${catA.id}/channels`, null, token);
        const chan3 = channelsA.data.find(c => c.name === "Channel 3");
        if (!chan3) {
             console.error("Channels in Cat A:", channelsA.data);
             throw new Error("❌ FAILURE: Channel 3 was NOT automatically added to Category A!");
        }
        console.log("   ✅ Channel 3 automatically added to Category A.");

        // Check Channels in Category B (Channel 2 should be added)
        const channelsB = await apiCall('GET', `/api/user-categories/${catB.id}/channels`, null, token);
        const chan2 = channelsB.data.find(c => c.name === "Channel 2");
        if (!chan2) {
             console.error("Channels in Cat B:", channelsB.data);
             throw new Error("❌ FAILURE: Channel 2 was NOT automatically added to Category B!");
        }
        console.log("   ✅ Channel 2 automatically added to Category B.");

        console.log("🎉 ALL TESTS PASSED!");

    } catch (e) {
        console.error("❌ TEST FAILED:", e.message);
        process.exitCode = 1;
    } finally {
        // Cleanup
        console.log("🧹 Cleaning up...");
        appProcess.kill();
        mockServer.close();
        if (fs.existsSync(DATA_DIR)) {
            fs.rmSync(DATA_DIR, { recursive: true, force: true });
        }
        process.exit();
    }
}

runTest();
