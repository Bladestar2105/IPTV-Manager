import http from 'http';

const server = http.createServer((req, res) => {
    req.on('close', () => console.log('req close'));
    res.on('close', () => console.log('res close'));
    res.on('finish', () => console.log('res finish'));
    res.end('done');
});

server.listen(3000, () => {
    const agent = new http.Agent({ keepAlive: true });
    http.get('http://localhost:3000', { agent }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
            console.log('client end');
            setTimeout(() => {
                console.log('client destroying agent');
                agent.destroy();
                server.close();
            }, 1000);
        });
    });
});
