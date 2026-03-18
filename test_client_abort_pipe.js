import http from 'http';
import { Readable } from 'stream';

const server = http.createServer((req, res) => {
    console.log(`Server: req started`);
    req.on('close', () => console.log(`Server: req closed`));

    const source = new Readable({
        read(size) {
            this.push('chunk\n');
        }
    });

    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Connection': 'keep-alive' });

    // Simulate what proxyLive or proxyTimeshift does
    source.pipe(res);

    req.on('close', () => {
        console.log('Server: req close event handling');
        if (!source.destroyed) {
            console.log('Server: destroying source');
            source.destroy();
        }
    });
});

server.listen(3000, () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const clientReq = http.get('http://localhost:3000', { agent }, (res) => {
        res.on('data', () => {});
        setTimeout(() => {
            console.log('Client: destroying request');
            clientReq.destroy();
        }, 500);
    });

    setTimeout(() => server.close(), 1000);
});
