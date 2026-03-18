import http from 'http';

const server = http.createServer((req, res) => {
    console.log(`Req: ${req.url} started`);
    req.on('close', () => console.log(`Req: ${req.url} closed`));
    res.on('finish', () => console.log(`Res: ${req.url} finished`));
    res.on('close', () => console.log(`Res: ${req.url} closed`));

    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Connection': 'keep-alive' });
    const iv = setInterval(() => res.write('chunk'), 100);

    req.on('close', () => clearInterval(iv));
});

server.listen(3000, () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const req1 = http.get('http://localhost:3000/1', { agent }, (res) => {
        res.on('data', () => {});
        res.on('end', () => console.log('Client: 1 ended'));

        setTimeout(() => {
            console.log('Client: req1.destroy()');
            req1.destroy();
        }, 500);
    });

    setTimeout(() => {
        server.close();
        agent.destroy();
    }, 1500);
});
