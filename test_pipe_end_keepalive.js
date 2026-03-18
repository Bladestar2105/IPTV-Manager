import http from 'http';
import { Readable } from 'stream';

const server = http.createServer((req, res) => {
    console.log(`Server: Req started`);
    req.on('close', () => console.log(`Server: Req closed`));
    res.on('finish', () => console.log(`Server: Res finished`));

    const source = new Readable({
        read(size) {
            this.push('chunk\n');
            this.push(null); // Ends stream immediately
        }
    });

    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Connection': 'keep-alive' });
    source.pipe(res);
});

server.listen(3000, () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const req1 = http.get('http://localhost:3000', { agent }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
            console.log('Client: req1 ended normally');
            // Keep agent open
        });
    });

    setTimeout(() => {
        agent.destroy();
        server.close();
    }, 1500);
});
