import http from 'http';

const server = http.createServer((req, res) => {
    console.log('Request started');
    req.on('close', () => console.log('req closed'));
    res.on('finish', () => console.log('res finished'));

    res.writeHead(200, { 'Content-Type': 'text/plain', 'Connection': 'keep-alive' });
    res.write('hello');
    setTimeout(() => {
        res.end('world');
        console.log('Called res.end()');
    }, 500);
});

server.listen(3000, async () => {
    const agent = new http.Agent({ keepAlive: true });
    console.log('Server listening. Making request...');
    const req = http.get('http://localhost:3000', { agent }, (res) => {
        res.on('data', d => console.log('got data:', d.toString()));
        res.on('end', () => console.log('client response ended'));
    });

    setTimeout(() => {
        console.log('Client destroying socket');
        agent.destroy();
        server.close();
    }, 2000);
});
