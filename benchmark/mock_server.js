import http from 'http';

const PORT = 4000;
const DELAY_MS = 500;

const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="1">
    <display-name>Test Channel</display-name>
  </channel>
  <programme start="20230101000000 +0000" stop="20230101010000 +0000" channel="1">
    <title>Test Program</title>
  </programme>
</tv>`;

const server = http.createServer((req, res) => {
  if (req.url === '/epg') {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(xmlContent);
    }, DELAY_MS);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Mock EPG server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
