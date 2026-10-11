import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

const forwardedIp = '198.51.100.123';

function createApp(trustedSubnet) {
    const app = express();
    app.set('trust proxy', trustedSubnet);
    app.get('/client-ip', (req, res) => {
        res.json({ ip: req.ip, socketIp: req.socket.remoteAddress });
    });
    return app;
}

describe('Express trust proxy dependency boundary', () => {
    // TRUST_PROXY accepts subnet strings in src/app.js. Unrelated IPv6 ranges
    // must not let an IPv4 peer override the client IP used by rate limiting.
    it.each(['::ffff:10.0.0.0/8', '::/1'])(
        'ignores X-Forwarded-For from an IPv4 peer outside %s',
        async (trustedSubnet) => {
            const response = await request(createApp(trustedSubnet))
                .get('/client-ip')
                .set('X-Forwarded-For', forwardedIp)
                .expect(200);

            expect(response.body.ip).toBe(response.body.socketIp);
            expect(response.body.ip).not.toBe(forwardedIp);
        }
    );

    it('accepts X-Forwarded-For from an explicitly trusted mapped IPv4 subnet', async () => {
        const response = await request(createApp('::ffff:127.0.0.0/104'))
            .get('/client-ip')
            .set('X-Forwarded-For', forwardedIp)
            .expect(200);

        expect(response.body.ip).toBe(forwardedIp);
    });
});
