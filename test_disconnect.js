import http from 'http';

const server = http.createServer((req, res) => {
    req.on('close', () => console.log('Server req close'));
    res.on('close', () => console.log('Server res close'));
    res.on('finish', () => console.log('Server res finish'));

    // Simulate long running stream
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Connection': 'keep-alive' });
    const interval = setInterval(() => {
        res.write('data');
    }, 100);

    req.on('close', () => clearInterval(interval));
});

server.listen(3000, () => {
    const req = http.get('http://localhost:3000', (res) => {
        setTimeout(() => {
            console.log('Client destroying req');
            req.destroy(); // simulate client disconnect
        }, 500);
    });

    setTimeout(() => server.close(), 1000);
});
