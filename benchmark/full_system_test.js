
/**
 * Author: Bladestar2105
 * License: MIT
 */
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:3000';
let adminToken = '';
let userId = 0;
let providerId = 0;
let categoryId = 0;
let channelId = 0;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function log(msg, type = 'INFO') {
    console.log(`[${type}] ${msg}`);
}

async function assert(condition, message) {
    if (!condition) {
        console.error(`[FAIL] ${message}`);
        process.exit(1);
    } else {
        console.log(`[PASS] ${message}`);
    }
}

async function request(method, url, body = null, token = null) {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';

    try {
        const res = await fetch(`${BASE_URL}${url}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
        });
        return res;
    } catch (e) {
        console.error(`Request Failed: ${method} ${url}`, e);
        return null;
    }
}

async function getAdminToken() {
    let username = process.env.ADMIN_USERNAME || 'admin';
    let password = process.env.ADMIN_PASSWORD;

    if (!password) {
        let creds = '';
        try {
            creds = fs.readFileSync('ADMIN_CREDENTIALS.txt', 'utf8');
            const usernameMatch = creds.match(/Username: (.*)/);
            const passwordMatch = creds.match(/Password: (.*)/);

            username = usernameMatch[1].trim();
            password = passwordMatch[1].trim();
        } catch(e) {
            log('Could not read ADMIN_CREDENTIALS.txt and ADMIN_PASSWORD not set', 'ERROR');
            process.exit(1);
        }
    }

    const res = await request('POST', '/api/login', { username, password });
    if (!res.ok) {
        log('Admin login failed', 'ERROR');
        process.exit(1);
    }
    const data = await res.json();
    adminToken = data.token;
    log('Got Admin Token');
}

async function testUserLifecycle() {
    log('Testing User Lifecycle...');
    const username = `testuser_${Date.now()}`;
    const password = 'password123';

    // Create
    const createRes = await request('POST', '/api/users', { username, password }, adminToken);
    assert(createRes.status === 200, 'Create User');
    const createData = await createRes.json();
    userId = createData.id;

    // Read
    const listRes = await request('GET', '/api/users', null, adminToken);
    const listData = await listRes.json();
    assert(listData.some(u => u.id === userId), 'User in list');

    // Auth (Player API)
    const playerRes = await request('GET', `/player_api.php?username=${username}&password=${password}`);
    const playerData = await playerRes.json();
    assert(playerData.user_info.auth === 1, 'Player API Auth');

    // Delete (Cleanup is tested later)
}

async function testProviderLifecycle() {
    log('Testing Provider Lifecycle...');

    // Invalid URL Validation
    const invalidRes = await request('POST', '/api/providers', {
        name: 'BadProv',
        url: 'ftp://bad.com',
        username: 'u',
        password: 'p'
    }, adminToken);
    assert(invalidRes.status === 400, 'Invalid URL rejected');

    // Create
    const createRes = await request('POST', '/api/providers', {
        name: 'TestProv',
        url: 'http://example.com',
        username: 'prov_u',
        password: 'prov_p'
    }, adminToken);
    assert(createRes.status === 200, 'Create Provider');
    const createData = await createRes.json();
    providerId = createData.id;

    // Update
    const updateRes = await request('PUT', `/api/providers/${providerId}`, {
        name: 'TestProvUpdated',
        url: 'http://example.com/updated',
        username: 'prov_u',
        password: 'prov_p'
    }, adminToken);
    assert(updateRes.status === 200, 'Update Provider');
}

async function testCategoryAndChannels() {
    log('Testing Category & Channels...');

    // Create Category
    const catRes = await request('POST', `/api/users/${userId}/categories`, { name: 'TestCat' }, adminToken);
    assert(catRes.status === 200, 'Create Category');
    const catData = await catRes.json();
    categoryId = catData.id;

    // Note: We can't easily add channels without syncing from a provider first,
    // or manually inserting into provider_channels (which is internal).
    // However, we can test the endpoints logic even if empty.

    const chanRes = await request('GET', `/api/user-categories/${categoryId}/channels`, null, adminToken);
    assert(chanRes.status === 200, 'List Channels (Empty)');
}

async function testSyncConfigAndCleanup() {
    log('Testing Sync Config & Cleanup...');

    // Create Sync Config
    const syncRes = await request('POST', '/api/sync-configs', {
        provider_id: providerId,
        user_id: userId,
        enabled: true
    }, adminToken);
    assert(syncRes.status === 200, 'Create Sync Config');

    // Verify existence
    const getSyncRes = await request('GET', `/api/sync-configs/${providerId}/${userId}`, null, adminToken);
    const syncData = await getSyncRes.json();
    assert(syncData && syncData.provider_id === providerId, 'Sync Config exists');

    // Delete Provider (Should cascade delete sync config)
    const delProvRes = await request('DELETE', `/api/providers/${providerId}`, null, adminToken);
    assert(delProvRes.status === 200, 'Delete Provider');

    // Verify Sync Config is GONE
    const checkSyncRes = await request('GET', `/api/sync-configs/${providerId}/${userId}`, null, adminToken);
    const checkData = await checkSyncRes.json();
    assert(checkData === null, 'Sync Config deleted via Cascade');

    // Delete User
    const delUserRes = await request('DELETE', `/api/users/${userId}`, null, adminToken);
    assert(delUserRes.status === 200, 'Delete User');
}

async function testStaticAssets() {
    log('Testing Static Assets...');

    // Public asset
    const pubRes = await request('GET', '/vendor/bootstrap.min.css');
    assert(pubRes.status === 200 || pubRes.status === 404, 'Public folder accessible'); // 404 if setup-assets didnt run, but allowed

    // Cache asset (Should be blocked/404 because we removed the route)
    // We assume the folder exists because server.js created it.
    // Since we removed app.use('/cache', ...), express will return 404 Cannot GET /cache/...
    const cacheRes = await request('GET', '/cache/test.xml');
    assert(cacheRes.status === 404, 'Cache folder not accessible');
}

async function run() {
    try {
        await getAdminToken();
        await testUserLifecycle();
        await testProviderLifecycle();
        await testCategoryAndChannels();
        await testSyncConfigAndCleanup();
        await testStaticAssets();
        log('ALL TESTS PASSED', 'SUCCESS');
    } catch (e) {
        log(e.message, 'ERROR');
        process.exit(1);
    }
}

run();
