import http from 'http';

const server = http.createServer((req, res) => {
    console.log(`Req started`);
    req.on('close', () => console.log(`Req closed`));
    res.on('finish', () => console.log(`Res finished`));
    res.on('close', () => console.log(`Res closed`));
    res.end('done');
});

server.listen(3000, () => {
    http.get('http://localhost:3000', (res) => {
        res.resume();
        res.on('end', () => {
            console.log('Client ended');
            server.close();
        });
    });
});
