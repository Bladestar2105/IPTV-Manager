import http from 'http';
import { Readable } from 'stream';

const server = http.createServer((req, res) => {
    console.log(`Req: ${req.url} started`);
    req.on('close', () => console.log(`Req: ${req.url} closed`));
    res.on('finish', () => console.log(`Res: ${req.url} finished`));

    const myStream = new Readable({
        read(size) {
            this.push('chunk\n');
            this.push(null);
        }
    });

    res.writeHead(200, { 'Content-Type': 'text/plain', 'Connection': 'keep-alive' });
    myStream.pipe(res);
});

server.listen(3000, () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const req1 = http.get('http://localhost:3000/1', { agent }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
            console.log('Client: 1 ended');
            // Keep the connection open for a bit
            setTimeout(() => {
                agent.destroy();
                server.close();
            }, 1000);
        });
    });
});
