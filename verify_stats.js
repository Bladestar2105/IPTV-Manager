import fetch from 'node-fetch';
const PORT = 3000;

async function run() {
    try {
        const loginRes = await fetch(`http://localhost:${PORT}/api/login`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({username: 'admin', password: 'secret'})
        });
        const loginData = await loginRes.json();
        const token = loginData.token;

        const statsRes = await fetch(`http://localhost:${PORT}/api/statistics`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const stats = await statsRes.json();
        console.log(JSON.stringify(stats, null, 2));

        if (Array.isArray(stats.active_streams) && Array.isArray(stats.top_channels)) {
            console.log('✅ Statistics Endpoint works');
        } else {
            console.error('❌ Invalid response');
            process.exit(1);
        }
    } catch(e) { console.error(e); process.exit(1); }
}
run();
