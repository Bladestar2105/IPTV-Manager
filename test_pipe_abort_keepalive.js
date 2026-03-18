import http from 'http';
import { Readable } from 'stream';

const server = http.createServer((req, res) => {
    console.log(`Req started`);
    req.on('close', () => console.log(`Req close`));

    const source = new Readable({
        read(size) {
            this.push('chunk\n');
        }
    });

    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Connection': 'keep-alive' });

    source.pipe(res);
});

server.listen(3000, () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const req1 = http.get('http://localhost:3000', { agent }, (res) => {
        res.on('data', () => {});
        // abort client request mid-stream
        setTimeout(() => {
            console.log('Client: req1.destroy()');
            req1.destroy();
        }, 500);
    });

    setTimeout(() => {
        agent.destroy();
        server.close();
    }, 1500);
});
