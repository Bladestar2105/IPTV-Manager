import http from 'http';

const server = http.createServer((req, res) => {
    console.log('Server: Request started');
    req.on('close', () => console.log('Server: req closed'));
    res.on('finish', () => console.log('Server: res finished'));
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('world');
});

server.listen(3000, () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const req1 = http.get('http://localhost:3000', { agent }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
            console.log('Client: req1 ended');
            // send req2 on same socket
            const req2 = http.get('http://localhost:3000', { agent }, (res2) => {
                res2.on('data', () => {});
                res2.on('end', () => {
                    console.log('Client: req2 ended');
                    setTimeout(() => {
                        console.log('Client: destroying agent');
                        agent.destroy();
                        server.close();
                    }, 500);
                });
            });
        });
    });
});
